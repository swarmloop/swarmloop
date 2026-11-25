import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunStop } from '../../agent/run-stop';
import { StepStopped } from '../../agent/step-stopped';
import { AppConfig } from '../../config/env';
import { REASON } from '../../contract/run-state';
import type { StepName } from '../../contract/steps';
import { Clock } from '../../core/clock';
import type { StartBy, StepOptions } from '../../core/pipeline-result';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { root } from '../../history/run-paths';
import { storedState } from '../../history/run-state';
import { VisitRepository } from '../../history/visit.repository';
import { VisitStartRepository } from '../../history/visit-start.repository';
import type { OpenedStep } from '../step-run';
import type { AgentLaunchRequest, LaunchOwner } from './agent-launch-request';
import { AgentLauncher } from './agent-launcher';
import type { LaunchResult } from './result-exchange';
import { answerErrorsByVisit } from './stored-answer-errors';
import { refusalLine, refusalQuestion, sameInput } from './same-input';
import { SpendLimit } from './spend-limit';
import { StartRefused } from './start-refused';
import type { ChainRefusal } from './start-refused';
import { readVisitInput, startInput } from './visit-input';
import type { StartInputParts } from './visit-input';

/** What the driver records of a start that was admitted. */
export interface AdmittedStart {
  /** The step runs an agent: its start is recorded and compared with the visits before it. */
  agent: boolean;
  /** The digest of the input the start runs on; null when the step is no agent or the input cannot be read. */
  digest: string | null;
  /** The start runs again a visit of the step that did not finish. */
  rerunUnfinished: boolean;
  /** The code of the run's stored reason when the start was made. */
  reason: string | null;
}

/** What the door says of a hop's start: it may go on, a limit or a stop holds it back, or the step already had this input. */
export type Admission =
  | { kind: 'admitted'; start: AdmittedStart }
  | { kind: 'blocked'; message: string }
  | ({ kind: 'refused' } & ChainRefusal);

/** A start that is not a step's visit: a planner turn, a reviewer, a chat. */
export interface OutsideStart {
  /** The name the start is recorded and compared under. */
  step: string;
  by: StartBy;
  /** The level of the planner that asks. Set only with `by: 'planner'`. */
  level?: number | null;
  /** The level of the planner this start runs, when it starts a planner: a refusal is never asked of it again. */
  plannerLevel?: number;
  input: StartInputParts;
  /** Called with the start's id before the launch, so a caller that stores the visit can link it with `linkVisit`. */
  admitted?: (startId: string) => void;
}

/** The visit a same-input check found: its number and its stored stat. */
type SameDecision = { visit: number; statId: number };

/** A step's visit that launches an agent. */
interface StepVisit {
  opened: OpenedStep;
  step: StepName;
  options: StepOptions;
}

/**
 * The one door every agent start of a run passes: a person's Stop, the spend and token limits, the refusal of a
 * start of the machine or a planner on the input its last visit had, and the one rule for write tools.
 */
@Injectable()
export class AgentDoor {
  /** The last same-input refusal for each run, until the driver takes it. */
  private readonly refusals = new Map<string, ChainRefusal>();

  constructor(
    private readonly launcher: AgentLauncher,
    private readonly runs: RunRepository,
    private readonly visits: VisitRepository,
    private readonly starts: VisitStartRepository,
    private readonly documents: DocumentRepository,
    private readonly limit: SpendLimit,
    private readonly config: AppConfig,
    private readonly runStop: RunStop,
    private readonly clock: Clock,
  ) {}

  /**
   * The check before a hop's agent start. A limit holds every start back. A person's start goes on. A start of the
   * machine or a planner is not made on a run a person stopped, nor on the input the step's last finished visit
   * had: the run waits, and the step's last words go up the planners' chain as a question.
   */
  async admitStep(key: string, step: StepName, options: StepOptions, agent: boolean): Promise<Admission> {
    const limited = await this.limit.spendStop(key, step);
    if (limited) return { kind: 'blocked', message: limited };
    const run = await this.runs.findRun(key);
    const by = options.startBy ?? 'person';
    const reason = run ? (storedState(run).reason?.code ?? null) : null;
    if (run && by !== 'person' && (await this.stopped(run))) {
      return {
        kind: 'blocked',
        message: `${key} is stopped. ${step} was not started; only a person's Resume starts it`,
      };
    }
    if (!run || !agent) {
      return { kind: 'admitted', start: { agent: false, digest: null, rerunUnfinished: false, reason } };
    }
    const digest = await this.inputOf(run, step, options);
    const decision = await this.hopDecision(run, step, digest, reason);
    if (decision.kind === 'new' || by === 'person') {
      const rerunUnfinished = decision.kind === 'new' && decision.rerunUnfinished;
      return { kind: 'admitted', start: { agent: true, digest, rerunUnfinished, reason } };
    }
    const refusal = await this.sameInputRefusal(run.id, step, by, options.level, undefined, decision);
    await this.runs.release(run, {
      status: 'waiting',
      currentStep: step,
      reason: { code: REASON.sameInput, message: refusal.message },
      stepStartedAt: null,
    });
    return { kind: 'refused', ...refusal };
  }

  /** Records how the hop's visit was started, once its step is open. */
  async noteStep(key: string, step: StepName, start: AdmittedStart, options: StepOptions): Promise<void> {
    const run = start.agent ? await this.runs.findRun(key) : null;
    if (!run?.activeAttempt) return;
    await this.noteVisit(run, step, run.activeAttempt, options, start);
  }

  /**
   * A launch inside a step's visit. A visit the hop started has its row already and goes on as it is; any other visit
   * is checked like a hop's start and gets its row. Write tools are allowed here only.
   */
  async inVisit(visit: StepVisit, request: AgentLaunchRequest): Promise<LaunchResult> {
    const { opened, step, options } = visit;
    if (!(await this.starts.has(opened.attemptId))) {
      const by = options.startBy ?? 'person';
      const run = await this.checked(request.key, step, by, request.run);
      if (run) {
        const reason = storedState(run).reason?.code ?? null;
        const digest = await this.inputOf(run, step, options);
        const decision = await this.hopDecision(run, step, digest, reason);
        if (decision.kind === 'same' && by !== 'person') {
          await this.refuse(run.id, step, by, options.level, undefined, decision, run.key);
        }
        await this.noteVisit(run, step, opened.attemptId, options, {
          digest,
          reason,
          rerunUnfinished: decision.kind === 'new' && decision.rerunUnfinished,
        });
      }
    }
    return this.launcher.launch(request);
  }

  /**
   * A start that is no step's visit. The rule for write tools is here and only here: code is written in a step's
   * visit, so every other start is refused write tools, before any check and with nothing written or launched.
   */
  async outside(start: OutsideStart, request: AgentLaunchRequest): Promise<LaunchResult> {
    if (request.tools === 'write') throw StartRefused.write();
    const run = await this.checked(request.key, start.step, start.by, request.run);
    const digest = run
      ? await startInput({ documents: this.documents, worktrees: this.worktreesOf(run) }, run, start.input)
      : null;
    if (run && start.by !== 'person') {
      await this.compareOutside(run, start, digest);
    }
    const startId = `start-${randomUUID()}`;
    await this.starts.note({
      runId: request.run.id,
      step: start.step,
      attemptId: startId,
      startedBy: start.by,
      level: start.by === 'planner' ? (start.level ?? null) : null,
      inputDigest: digest,
      startReason: null,
      rerunUnfinished: false,
      outside: true,
      statId: null,
      createdAt: this.clock.iso(),
    });
    start.admitted?.(startId);
    return this.launcher.launch(request);
  }

  /** Links the start to the visit stored for it. */
  async linkVisit(startId: string, statId: number): Promise<void> {
    await this.starts.link(startId, statId);
  }

  /** The last same-input refusal the door made for a start of the run. Taking it clears it. */
  takeRefusal(key: string): ChainRefusal | null {
    const refusal = this.refusals.get(key) ?? null;
    this.refusals.delete(key);
    return refusal;
  }

  /**
   * The Stop and the limits, once for every start that is not a hop's. A person's Stop refuses every start; a stored
   * Stop refuses a start of the machine or a planner. While a step holds the run, the limits are read on the launch's
   * own run; otherwise the run is blocked as a hop's start over a limit blocks it. Returns the stored run.
   */
  private async checked(key: string, step: string, by: StartBy, owner: LaunchOwner): Promise<RunEntity | null> {
    if (this.runStop.halted(key)) throw new StepStopped();
    const run = await this.runs.findRun(key);
    if (!run) return null;
    if (by !== 'person' && (await this.stopped(run))) throw new StepStopped();
    if (run.status === 'running') {
      if (await this.limit.overLimit(owner)) {
        const message = `${key} is over the spend limit. ${step} was not started`;
        await this.documents.putDocument(run, 'spend', `${message}\n`);
        throw StartRefused.limit(message);
      }
    } else {
      const limited = await this.limit.spendStop(key, run.currentStep as StepName);
      if (limited) throw StartRefused.limit(limited);
    }
    return run;
  }

  /** Whether the start has the input of the same step's last visit that a hop started. */
  private async hopDecision(run: RunEntity, step: string, digest: string | null, reason: string | null) {
    return sameInput({
      step,
      digest,
      stats: await this.statsWithErrors(run.id),
      starts: (await this.starts.forRun(run.id)).filter((start) => !start.outside),
      reasonCode: reason,
    });
  }

  /** The run's visits, each with the errors its answer was refused for. */
  private async statsWithErrors(runId: number) {
    const errors = await answerErrorsByVisit({ documents: this.documents }, runId);
    return (await this.visits.listStats(runId)).map((stat) => ({ ...stat, answerErrors: errors.get(stat.id) }));
  }

  /** Refuses an outside start of the machine or a planner that has the input of the last visit of its step. */
  private async compareOutside(run: RunEntity, start: OutsideStart, digest: string | null): Promise<void> {
    const own = (await this.starts.forRun(run.id)).filter((row) => row.outside && row.step === start.step);
    const stats = (await this.statsWithErrors(run.id)).flatMap((stat) => {
      const linked = own.find((row) => row.statId === stat.id);
      return linked ? [{ ...stat, step: start.step, attemptId: linked.attemptId }] : [];
    });
    const decision = sameInput({ step: start.step, digest, stats, starts: own, reasonCode: null });
    if (decision.kind === 'same') {
      await this.refuse(run.id, start.step, start.by, start.level, start.plannerLevel, decision, run.key);
    }
  }

  /** Keeps the refusal for the driver and throws it. A refused planner is never asked its own question again. */
  private async refuse(
    runId: number,
    step: string,
    by: StartBy,
    level: number | null | undefined,
    plannerLevel: number | undefined,
    decision: SameDecision,
    key: string,
  ): Promise<never> {
    const refusal = await this.sameInputRefusal(runId, step, by, level, plannerLevel, decision);
    this.refusals.set(key, refusal);
    throw StartRefused.sameInput(refusal);
  }

  /** The words of a same-input refusal: the line, the step's last words as a question, and the level that is asked. */
  private async sameInputRefusal(
    runId: number,
    step: string,
    by: StartBy,
    level: number | null | undefined,
    plannerLevel: number | undefined,
    decision: SameDecision,
  ): Promise<ChainRefusal> {
    const startLevel = plannerLevel !== undefined ? plannerLevel + 1 : by === 'planner' ? (level ?? 0) + 1 : 0;
    const who = startLevel === 0 ? 'the planner of this run' : "the epic's planner";
    const [last] = (await this.visits.listExchanges([decision.statId])).slice(-1);
    return {
      message: refusalLine(decision.visit, who),
      question: refusalQuestion(
        step,
        decision.visit,
        last?.responseText ?? '',
        (await answerErrorsByVisit({ documents: this.documents }, runId)).get(decision.statId),
      ),
      startLevel,
    };
  }

  /** Writes the row of a step's visit the door admitted. */
  private async noteVisit(
    run: RunEntity,
    step: StepName,
    attemptId: string,
    options: StepOptions,
    start: Pick<AdmittedStart, 'digest' | 'reason' | 'rerunUnfinished'>,
  ): Promise<void> {
    const by = options.startBy ?? 'person';
    await this.starts.note({
      runId: run.id,
      step,
      attemptId,
      startedBy: by,
      level: by === 'planner' ? (options.level ?? null) : null,
      inputDigest: start.digest,
      startReason: start.reason,
      rerunUnfinished: start.rerunUnfinished,
      outside: false,
      statId: null,
      createdAt: this.clock.iso(),
    });
  }

  /** Whether a person stopped the run. The run is read again, so a copy from before the Stop does not count. */
  async stopped(run: Pick<RunEntity, 'key'>): Promise<boolean> {
    const stored = await this.runs.findRun(run.key);
    return stored?.status === 'blocked' && storedState(stored).reason?.code === REASON.stopped;
  }

  private worktreesOf(run: Pick<RunEntity, 'key'>): string {
    return join(root(this.config), 'worktrees', run.key);
  }

  /** The digest of the input the step would start on, or null when the run has no worktrees to read the heads of. */
  private async inputOf(run: RunEntity, step: StepName, options: StepOptions): Promise<string | null> {
    const worktrees = this.worktreesOf(run);
    if (!run.targetPath && !existsSync(worktrees)) return null;
    return readVisitInput({ documents: this.documents, worktrees }, run, step, options.prompt ?? '');
  }
}

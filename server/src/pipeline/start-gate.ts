import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { REASON } from '../contract/run-state';
import type { StepName } from '../contract/steps';
import type { StartBy, StepOptions } from '../core/pipeline-result';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { root } from '../history/run-paths';
import { storedState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
import { readVisitInput } from '../steps/shared/visit-input';
import type { ChainQuestion } from '../steps/shared/subtask-ops';
import { StepRegistry } from '../steps/step.registry';
import { CommandService } from './command.service';
import { PERSON_RESUME } from './resume-sender';
import { RunGuards } from './run-guards';
import { refusalLine, refusalQuestion, sameInput } from './same-input';

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

/** What the gate says of a start: it may go on, a limit or a stop holds it back, or the step already had this input. */
type Admission =
  | { kind: 'admitted'; start: AdmittedStart }
  | { kind: 'blocked'; message: string }
  | {
      kind: 'refused';
      /** The refusal line the run page shows while a planner is asked. */
      message: string;
      /** What goes up the planners' chain: the step's last words under the refusal line. */
      question: ChainQuestion;
      /** The level of the planner the question starts at: 0 for the machine, one above the planner that asked. */
      startLevel: number;
    };

interface StartRequest {
  by: StartBy;
  /** The idempotency key. It names the event the resume is for, never a counter that other writes move. */
  event: string;
  /** The level of the planner that asks. Set only with `by: 'planner'`. */
  level?: number;
  actor?: string | null;
  payload?: Record<string, unknown>;
}

/** The one door a resume of a run passes when the person's routes are not the caller. */
@Injectable()
export class StartGate {
  constructor(
    private readonly commands: CommandService,
    private readonly runs: RunRepository,
    private readonly guards: RunGuards,
    private readonly visits: VisitRepository,
    private readonly starts: VisitStartRepository,
    /** The registry is found when a start is admitted: the steps reach the subtask port, which holds this gate. */
    private readonly modules: ModuleRef,
    private readonly documents: DocumentRepository,
    private readonly config: AppConfig,
  ) {}

  /** Why the step may not start on the spend and token limits, or null. */
  limits(key: string, step: StepName): Promise<string | null> {
    return this.guards.spendStop(key, step);
  }

  /**
   * The one check before every agent start. A limit holds every start back. A person's start goes on. A start of the
   * machine or a planner is not made on a run a person stopped, nor on the input the step's last finished visit
   * had: the run waits, and the step's last words go up the planners' chain as a question.
   */
  async admit(key: string, step: StepName, options: StepOptions): Promise<Admission> {
    const limited = await this.limits(key, step);
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
    if (!run || !(await this.launchesAgent(key, step))) {
      return { kind: 'admitted', start: { agent: false, digest: null, rerunUnfinished: false, reason } };
    }
    const digest = await this.inputOf(run, step, options);
    const decision = sameInput({
      step,
      digest,
      stats: await this.visits.listStats(run.id),
      starts: await this.starts.forRun(run.id),
      reasonCode: reason,
    });
    if (decision.kind === 'new' || by === 'person') {
      const rerunUnfinished = decision.kind === 'new' && decision.rerunUnfinished;
      return { kind: 'admitted', start: { agent: true, digest, rerunUnfinished, reason } };
    }
    const startLevel = by === 'planner' ? (options.level ?? 0) + 1 : 0;
    const who = startLevel === 0 ? 'the planner of this run' : "the epic's planner";
    const message = refusalLine(decision.visit, who);
    await this.runs.release(run, {
      status: 'waiting',
      currentStep: step,
      reason: { code: REASON.sameInput, message },
      stepStartedAt: null,
    });
    const [last] = (await this.visits.listExchanges([decision.statId])).slice(-1);
    return {
      kind: 'refused',
      message,
      question: refusalQuestion(step, decision.visit, last?.responseText ?? ''),
      startLevel,
    };
  }

  /** Whether a start of the step launches an agent: a server pass, such as a split parent's implement, does not. */
  private async launchesAgent(key: string, step: StepName): Promise<boolean> {
    const found = this.modules.get(StepRegistry, { strict: false }).get(step);
    if (!found) return false;
    return found.launchesAgent ? found.launchesAgent(key) : found.usesModel;
  }

  /** The digest of the input the step would start on, or null when the run has no worktrees to read the heads of. */
  private async inputOf(run: RunEntity, step: StepName, options: StepOptions): Promise<string | null> {
    const worktrees = join(root(this.config), 'worktrees', run.key);
    if (!run.targetPath && !existsSync(worktrees)) return null;
    return readVisitInput({ documents: this.documents, worktrees }, run, step, options.prompt ?? '');
  }

  /** Whether a person stopped the run. The run is read again, so a copy from before the Stop does not count. */
  async stopped(run: Pick<RunEntity, 'key'>): Promise<boolean> {
    const stored = await this.runs.findRun(run.key);
    return stored?.status === 'blocked' && storedState(stored).reason?.code === REASON.stopped;
  }

  /**
   * Resumes the run once per event. A run a person stopped is resumed only by a person, or by a planner that acts on a
   * person's message (its payload carries the person's mark); for the machine and any other planner it answers `stopped`.
   */
  async resume(run: Pick<RunEntity, 'key'>, request: StartRequest): Promise<'accepted' | 'replayed' | 'stopped'> {
    const personal = request.by === 'person' || request.payload?.by === PERSON_RESUME.by;
    if (!personal && (await this.stopped(run))) return 'stopped';
    const level = request.by === 'planner' ? (request.level ?? null) : null;
    const payload = personal
      ? { ...request.payload, ...PERSON_RESUME, level }
      : { ...request.payload, by: request.by, level };
    const { replayed } = await this.commands.accept('resume', run.key, payload, {
      idempotencyKey: request.event,
      actor: request.actor,
    });
    return replayed ? 'replayed' : 'accepted';
  }
}

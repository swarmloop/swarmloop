import { existsSync, realpathSync, statSync } from 'fs';
import type { AppConfig } from '../config/env';
import type { RunStop } from '../agent/run-stop';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity, StepStatEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { Clock } from '../core/clock';
import type { ProjectAppendService } from '../steps/prepare/project-append.service';
import type { StepRegistry } from '../steps/step.registry';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import {
  autoContinues,
  countedVisits,
  continues,
  lastVisitStatus,
  failedLaunches,
  isStep,
  loopMark,
  ownBlockCode,
  settle,
} from '../core/pipeline-result';
import { REASON } from '../contract/run-state';
import { isSubtask } from '../contract/subtask';
import type { StepName } from '../contract/steps';
import { STEPS } from '../contract/steps';
import { assertInsideWork, workRoots } from '../sandbox/allowed-path';
import { flagError } from './flag-error';
import { storedState, writeRunState } from '../history/run-state';
import type { RunGuards } from './run-guards';
import type { AgentDoor } from '../steps/shared/agent-door';
import type { ChainRefusal } from '../steps/shared/start-refused';
import { HopGate } from './hop-gate';
import { PlannerTurnPass } from './planner-turn-pass';
import type { StartGate } from './start-gate';
import type { SubtaskPort } from './subtask-port';
import type { LimitRelease } from '../steps/shared/limit-release';
import { storedAnswerErrors } from '../steps/shared/stored-answer-errors';
import type { ReportRefresh } from '../steps/shared/report-refresh';
import type { PlannerTurns } from './planner-turns';

const HOP_LIMIT = STEPS.length * 3;

/** The options of every hop after the first: the driver itself asks for the start. */
const FOLLOWING: StepOptions = { auto: true, startBy: 'machine' };

export class RunDriver {
  private readonly hop: HopGate;
  private readonly pass: PlannerTurnPass;

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly registry: StepRegistry,
    private readonly config: AppConfig,
    private readonly visits: VisitRepository,
    private readonly runStop: RunStop,
    private readonly clock: Clock,
    private readonly projects: ProjectAppendService,
    private readonly guards: RunGuards,
    gate: StartGate,
    private readonly door: AgentDoor,
    private readonly subtasks?: SubtaskPort,
    private readonly limits?: LimitRelease,
    private readonly reportRefresh?: ReportRefresh,
    private readonly turns?: PlannerTurns,
  ) {
    this.hop = new HopGate(gate, guards, runs, door, subtasks);
    this.pass = new PlannerTurnPass(runs, turns, door, this.hop, (key) => this.execute('plan', key, { auto: true }));
  }

  async savedStep(
    key: string,
    keyError: (key: string) => PipelineResult | null,
    busy: (key: string) => Promise<boolean>,
  ): Promise<{ step: StepName } | PipelineResult> {
    const invalid = keyError(key);
    if (invalid) return invalid;
    if (await busy(key)) return { exitCode: 1, message: `${key} is already running` };
    const existing = await this.runs.findRun(key);
    if (existing?.status === 'done') return { exitCode: 0, message: `${key} is done` };
    const step = existing?.currentStep ?? STEPS[0];
    if (!isStep(step)) return { exitCode: 1, message: `${step} is unknown` };
    return { step };
  }

  /** Drives the run, then tells its parent, if it has one, that this subtask changed. */
  async drive(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    const wake = await this.subtasks?.leavingKey(key);
    const opened = wake ? async () => this.subtasks?.notifyParent(key, wake) : undefined;
    try {
      if (options.auto !== true) await this.limits?.release(key);
      return await this.driveSteps(name, key, opened ? { ...options, opened } : options);
    } finally {
      await this.subtasks?.notifyParent(key);
    }
  }

  /** True while a question waits. A subtask goes on past what it handed up in a message; it stops only while it waits for the planner. */
  private async waitsOnQuestion(key: string): Promise<boolean> {
    if (!(await this.turns?.hasQuestion(key))) return false;
    const run = await this.runs.findRun(key);
    return !run || !isSubtask(run) || asksPlanner(run);
  }

  /** True while the step waits for the planner of its own run, which has a question of the step in its plan chat to take. */
  private async waitsForPlanner(run: RunEntity | null, step: StepName, key: string): Promise<boolean> {
    if (!run || run.currentStep !== step || !asksPlanner(run)) return false;
    return !this.turns || (await this.turns.hasQuestion(key));
  }

  private async driveSteps(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    let step = name;
    let stepOptions = options;
    let manual = options.auto !== true;
    let result: PipelineResult = { exitCode: 0, message: `${key} started` };
    let ran = false;
    const declined = new Set<string>();
    for (let hop = 0; hop < HOP_LIMIT; hop += 1) {
      if (this.runStop.halted(key)) {
        return { exitCode: ran ? 0 : 1, message: `${key} stopped` };
      }
      const rebased = (await this.subtasks?.applyPendingRebase(key)) as StepName | null | undefined;
      if (rebased) {
        // A taken rebase relaunches the run on a new head: a new round, as a person's start.
        step = rebased;
        manual = true;
      }
      const gate = await this.hop.passGate(key, step, stepOptions);
      if ('message' in gate) {
        return { exitCode: ran ? 0 : 1, message: gate.message };
      }
      if ('again' in gate) {
        // A planner answered the question of a start that was refused: the step goes on from the answer.
        stepOptions = gate.again;
        continue;
      }
      const taken = await this.pass.run(key, declined);
      if (taken && 'message' in taken) {
        return { exitCode: ran ? 0 : 1, message: taken.message };
      }
      if (taken && 'again' in taken) {
        // A planner answered the question of a turn that was refused: the drive goes on from the answer.
        stepOptions = taken.again;
        continue;
      }
      if (taken) {
        step = taken.step;
        stepOptions = FOLLOWING;
      } else if (await this.waitsOnQuestion(key)) {
        // The question waits for the planner, or for the person it was escalated to: nothing runs.
        return result;
      }
      this.door.takeRefusal(key);
      result = await this.execute(step, key, {
        ...stepOptions,
        opened: this.hop.opening(key, step, gate.start, stepOptions),
      });
      const refusal = this.door.takeRefusal(key);
      ran = true;
      if (manual) {
        await this.markLoop(key);
        manual = false;
      }
      if (this.runStop.halted(key)) {
        return result;
      }
      const after = await this.nextHop(step, key, result, stepOptions, refusal);
      if ('end' in after) return after.end;
      if ('again' in after) {
        stepOptions = after.again;
        continue;
      }
      step = after.next;
      stepOptions = FOLLOWING;
    }
    return result;
  }

  /**
   * What the drive does after a step ran: ask the chain when the door refused a start of the step for the same input,
   * start the step again, go on to the next step, or end with the step's result.
   */
  private async nextHop(
    step: StepName,
    key: string,
    result: PipelineResult,
    stepOptions: StepOptions,
    refusal: ChainRefusal | null,
  ): Promise<{ end: PipelineResult } | { again: StepOptions } | { next: StepName }> {
    const run = await this.runs.findRun(key);
    if (refusal && run?.status === 'waiting' && storedState(run).reason?.code === REASON.sameInput) {
      const asked = await this.hop.askChain(key, refusal);
      return 'again' in asked ? asked : { end: { exitCode: 0, message: asked.message } };
    }
    const mark = loopMark(await this.documents.latestBody(key, 'loop_mark'));
    const stats = run ? await this.visits.listStats(run.id) : [];
    const env = this.config.env;
    if (await this.waitsForPlanner(run, step, key)) {
      // The next hop takes the question to the planner; the step goes on with its answer. A question only the backlog's planner holds is not in the run's plan chat: the drive ends.
      return { again: FOLLOWING };
    }
    if (result.resume && run?.status === 'waiting' && run.currentStep === step) {
      return { again: FOLLOWING };
    }
    if (
      run?.status === 'failed' &&
      run.currentStep === step &&
      step !== 'done' &&
      failedLaunches(stats, step, mark) < env.MAX_LAUNCHES
    ) {
      return { again: { ...stepOptions, ...FOLLOWING } };
    }
    return this.following(step, run, stats, mark, result);
  }

  /** The step after a finished one, or the end of the drive; a run that has gone round too often is blocked on it. */
  private async following(
    step: StepName,
    run: RunEntity | null,
    stats: StepStatEntity[],
    mark: number,
    result: PipelineResult,
  ): Promise<{ end: PipelineResult } | { next: StepName }> {
    const lastVisit = lastVisitStatus(stats, step);
    const next = continues(step, run, lastVisit);
    const visits = next ? countedVisits(stats, next, mark) : 0;
    const following = autoContinues(step, run, visits, this.config.env.MAX_RETURNS, lastVisit);
    if (following) return { next: following };
    if (next && run) {
      await this.guards.block(
        run,
        next,
        REASON.loopLimit,
        `${next} ran ${visits} times (MAX_RETURNS); Resume starts another round`,
      );
    }
    return { end: result };
  }

  async markLoop(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (!run) {
      return;
    }
    const stats = await this.visits.listStats(run.id);
    const mark = stats.reduce((max, item) => Math.max(max, item.id), 0);
    await this.documents.putDocument(run, 'loop_mark', `${mark}\n`);
  }

  /** The errors of the answer the step's latest visit failed on. A later visit that did not fail leaves none. */
  private async answerErrorsOf(key: string, name: StepName): Promise<string[] | undefined> {
    const run = await this.runs.findRun(key);
    return run ? storedAnswerErrors({ documents: this.documents, visits: this.visits }, run.id, name) : undefined;
  }

  async execute(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    const pendingError = await this.applyPending(key);
    if (pendingError) {
      return { exitCode: 1, message: pendingError };
    }
    const step = this.registry.get(name);
    if (step) {
      const answerErrors = options.answerErrors ?? (await this.answerErrorsOf(key, name));
      return step.execute(key, answerErrors ? { ...options, answerErrors } : options, async (run) => {
        await this.reportRefresh?.refresh(run);
      });
    }
    // Without a service for the step, the driver runs it from here. Only a registry without that step gets this far.
    const prior = await this.runs.findRun(key);
    const previousStep = prior?.currentStep ?? name;
    const previousStatus = prior?.status ?? 'waiting';
    const run = await this.runs.begin(key, name);
    if (options.path) {
      assertInsideWork(options.path, workRoots(this.config));
      run.targetPath = realpathSync(options.path);
    }
    const settled = settle(previousStep, previousStatus, name, 'blocked');
    const line = `${this.clock.iso()} ${name} not implemented`;
    writeRunState(run, {
      status: settled.status,
      currentStep: settled.currentStep,
      reason: { code: ownBlockCode(name), message: line },
    });
    await this.runs.saveRun(run);
    return { exitCode: 1, message: line };
  }

  async applyPending(key: string): Promise<string | null> {
    try {
      await this.projects.flush(key);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'repository failed';
      const run = await this.runs.findRun(key);
      if (run && run.status !== 'running') {
        writeRunState(run, { status: 'failed' });
        await this.runs.saveRun(run);
        await this.documents.putDocument(run, 'error', `${message}\n`);
      }
      return message;
    }
  }

  async missingInput(name: StepName, key: string, options: StepOptions): Promise<string | null> {
    return this.registry.get(name)?.missingInput(key, options) ?? null;
  }

  async start(
    name: StepName,
    key: string,
    options: StepOptions,
    busy: (key: string) => Promise<boolean>,
  ): Promise<PipelineResult> {
    const flagged = flagError(this.registry.get(name), options);
    if (flagged) return { exitCode: 1, message: flagged };
    const pathError = targetError(options.path);
    if (pathError) return { exitCode: 1, message: pathError };
    const missing = await this.missingInput(name, key, options);
    if (missing) return { exitCode: 1, message: `${missing} is missing` };
    if (await busy(key)) return { exitCode: 1, message: `${key} is already running` };
    const unfit = await this.guards.stopBefore(key, name);
    if (unfit) return { exitCode: 1, message: unfit };
    return this.execute(name, key, options);
  }
}

/** The run waits with the reason that its step asked the planner. */
function asksPlanner(run: RunEntity): boolean {
  return run.status === 'waiting' && storedState(run).reason?.code === REASON.asksPlanner;
}

function targetError(path: string | undefined): string | null {
  if (path === undefined) return null;
  if (!existsSync(path) || !statSync(path).isDirectory()) return 'path is not a directory';
  return null;
}

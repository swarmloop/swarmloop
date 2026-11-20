import { Injectable } from '@nestjs/common';
import { SUBTASK_WAIT_CODES } from '../../contract/error-codes';
import { deriveState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import { readyTasks, settled, withStatuses } from '../../contract/subtask';
import type { StepName } from '../../contract/steps';
import { SubtaskOps } from '../shared/subtask-ops';
import { taskStatusOf } from '../shared/subtask-status';
import { SplitMerge } from './split-merge';
import { SplitNeeds } from './split-needs';
import { SplitPass } from './split-pass';
import { StarterInbox } from './starter-inbox';
import { earliestRetry } from './subtask-retry';
import { BaseStep, StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';
import type { PipelineResult, StepOptions } from '../../core/pipeline-result';
import type { StepSnapshot } from '../step';
import { StepKernel } from '../step-kernel';

const INPUTS = {
  subtasks: { artifact: ARTIFACTS.subtasks, need: 'run' },
} as const satisfies InputSpec;

/**
 * Implement of a split run: a server step, no agent. A pass does what is due and ends with the parent waiting, so
 * it never holds the run. It starts again when a subtask changes status or on the reconciler timer. A pass is
 * idempotent and the only place that decides what happens next. It takes what the subtasks report and answers one
 * question of a subtask first: the answer is a decision in the `contract`, and its actions change the task list. A pass with nothing new opens no step: it adds no visit and no attempt.
 */
@Injectable()
export class SplitImplementStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'implement';
  readonly inputs = INPUTS;
  readonly outputs = [
    ARTIFACTS.subtasks,
    ARTIFACTS.implementation,
    ARTIFACTS.implementationResult,
    ARTIFACTS.contract,
    ARTIFACTS.subtaskQuestions,
    ARTIFACTS.questionParts,
    ARTIFACTS.starterTaken,
  ];

  private readonly needs: SplitNeeds;
  private readonly inbox: StarterInbox;
  private readonly pass: SplitPass;

  constructor(
    kernel: StepKernel,
    private readonly subtasks: SubtaskOps,
    merges: SplitMerge,
  ) {
    super(kernel);
    this.needs = new SplitNeeds(subtasks);
    this.inbox = new StarterInbox({ subtasks, reader: this.reader });
    this.pass = new SplitPass({
      subtasks,
      merges,
      needs: this.needs,
      inbox: this.inbox,
      documents: this.documents,
      clock: this.clock,
      config: this.config,
      flows: this.flows,
      visits: this.visits,
    });
  }

  override async execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    const parent = await this.runs.findRun(key);
    if (parent && (await this.quiet(parent))) {
      await this.runs.recordSubtaskFingerprint(parent, await this.runs.subtaskFingerprint(parent));
      return { exitCode: 0, message: `${key} has nothing new` };
    }
    // Taken before the pass reads the subtasks: a subtask that changes during the pass, whose resume is a no-op,
    // still differs from it, so the timer starts the pass that sees it.
    const seen = parent ? await this.runs.subtaskFingerprint(parent) : null;
    const result = await super.execute(key, options, snapshot);
    if (parent && seen !== null) await this.runs.recordSubtaskFingerprint(parent, seen);
    return result;
  }

  /** True when a pass would merge, start, answer, finish and write nothing: the parent waits and every open task is as it was. */
  private async quiet(parent: RunEntity): Promise<boolean> {
    const code = deriveState(parent).reason?.code ?? '';
    if (parent.status !== 'waiting' || !SUBTASK_WAIT_CODES.some((wait) => wait === code)) return false;
    const tasks = withStatuses((await this.reader.reread(parent.key, ARTIFACTS.subtasks)) ?? []);
    if (tasks.every(settled) || (await this.needs.pending(parent, tasks))) return false;
    if (await this.inbox.pending(parent, tasks)) return false;
    const children: RunEntity[] = [];
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.subtasks.find(parent, task.id);
      if (!child) return false;
      children.push(child);
      const { state } = deriveState(child);
      const changed = state === 'stopped' || taskStatusOf(task, child) !== task.status;
      if (changed || task.status === 'green' || (await this.subtasks.asking(child))) return false;
    }
    if (earliestRetry(children) !== (deriveState(parent).reason?.retryAt ?? null)) return false;
    return readyTasks(tasks, await this.pass.slots(parent, tasks)).length === 0;
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    return this.pass.run(input.subtasks, ctx);
  }
}

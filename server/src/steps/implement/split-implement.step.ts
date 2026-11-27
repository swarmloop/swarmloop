import { Injectable, Optional } from '@nestjs/common';
import { SUBTASK_WAIT_CODES } from '../../contract/error-codes';
import { storedState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import { readyTasks, runWaitNote, settled, withStatuses, type Subtask } from '../../contract/subtask';
import type { StepName } from '../../contract/steps';
import { SubtaskOps } from '../shared/subtask-ops';
import { taskStatusOf } from '../shared/subtask-status';
import { PlanConversation } from '../shared/plan-conversation';
import { MergeMarks } from '../shared/merge-marks';
import { MergeLook } from './merge-look';
import { REBASED_PREFIX } from './split-rebase';
import { SplitMerge } from './split-merge';
import { implementRunner } from './split-or-fix';
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
    ARTIFACTS.rebaseConflict,
    ARTIFACTS.contract,
    ARTIFACTS.subtaskQuestions,
    ARTIFACTS.questionParts,
    ARTIFACTS.starterTaken,
    ARTIFACTS.mergeLook,
  ];

  private readonly needs: SplitNeeds;
  private readonly inbox: StarterInbox;
  private readonly look: MergeLook;
  private readonly pass: SplitPass;

  constructor(
    kernel: StepKernel,
    private readonly subtasks: SubtaskOps,
    merges: SplitMerge,
    @Optional() conversation?: PlanConversation,
  ) {
    super(kernel);
    this.needs = new SplitNeeds(subtasks);
    this.inbox = new StarterInbox({ subtasks, reader: this.reader });
    this.look = new MergeLook({
      subtasks,
      reader: this.reader,
      marks: new MergeMarks(this.documents),
      config: this.config,
      conversation,
    });
    this.pass = new SplitPass({
      subtasks,
      merges,
      needs: this.needs,
      inbox: this.inbox,
      documents: this.documents,
      look: this.look,
      clock: this.clock,
      config: this.config,
      flows: this.flows,
      visits: this.visits,
    });
  }

  override async execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    const parent = await this.runs.findRun(key);
    // A person's Resume or message always runs the pass: the parent's own edits may have changed with no task changing.
    if (parent && options.startBy !== 'person' && (await this.quiet(parent))) {
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
    const code = storedState(parent).reason?.code ?? '';
    if (parent.status !== 'waiting' || !SUBTASK_WAIT_CODES.some((wait) => wait === code)) return false;
    const tasks = withStatuses((await this.reader.reread(parent.key, ARTIFACTS.subtasks)) ?? []);
    if (tasks.every(settled) || (await this.needs.pending(parent, tasks))) return false;
    if (await this.inbox.pending(parent, tasks)) return false;
    if (await this.look.pending(parent, tasks)) return false;
    const children: RunEntity[] = [];
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.subtasks.find(parent, task.id);
      if (!child) return false;
      children.push(child);
      if (this.changed(task, child) || task.status === 'green' || (await this.subtasks.asking(child))) return false;
    }
    if (earliestRetry(children) !== (storedState(parent).reason?.retryAt ?? null)) return false;
    return readyTasks(tasks, await this.pass.slots(parent, tasks)).length === 0;
  }

  /** A task whose run stopped, whose status moved, or whose running run waits with another text than the task carries. */
  private changed(task: Subtask, child: RunEntity): boolean {
    const { state, reason } = storedState(child);
    const status = taskStatusOf(task, child);
    if (state === 'stopped' || status !== task.status) return true;
    if (status !== 'running') return false;
    const carried = task.note?.startsWith(REBASED_PREFIX) ? undefined : task.note;
    return runWaitNote(task, { state, stateReason: reason }) !== carried;
  }

  /** Who runs the implement of the run now: the agent, or this server pass. */
  runner(run: RunEntity | null): Promise<'agent' | 'split'> {
    return implementRunner(this.reader, this.documents, this.subtasks, run);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    return this.pass.run(input.subtasks, ctx);
  }
}

import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../contract/error-codes';
import { deriveState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import { readyTasks, settled, statusLine, unmetDepends, withStatuses, type Subtask } from '../../contract/subtask';
import type { StepName } from '../../contract/steps';
import { withDecision } from '../shared/handoff';
import { SubtaskOps } from '../shared/subtask-ops';
import { SplitMerge } from './split-merge';
import { BaseStep, StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';

const INPUTS = {
  subtasks: { artifact: ARTIFACTS.subtasks, need: 'run' },
} as const satisfies InputSpec;

export const NO_CI_NOTE = 'no CI on the feature branch';

/**
 * Implement of a split run: a server step, no agent. A pass does what is due and ends with the parent waiting, so
 * it never holds the run. It starts again when a subtask changes status or on the reconciler timer. A pass is
 * idempotent and the only place that decides what happens next. It answers one question of a subtask first: the
 * answer is a decision in the `contract`.
 */
@Injectable()
export class SplitImplementStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'implement';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.subtasks, ARTIFACTS.implementation, ARTIFACTS.contract];

  constructor(
    kernel: StepKernel,
    private readonly subtasks: SubtaskOps,
    private readonly merges: SplitMerge,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { run, startedAt } = ctx.opened;
    const before = JSON.stringify(withStatuses(input.subtasks));
    const contract = await this.answer(ctx, withStatuses(input.subtasks));
    const followed = await this.refresh(run, withStatuses(input.subtasks));
    const { tasks: merged, refusal } = await this.merges.run(run, followed);
    const blocked = merged.find((task) => task.status === 'blocked');
    const tasks = await this.explain(run, blocked || refusal ? merged : await this.start(run, merged));
    const outputs: StepResult['outputs'] = [
      ...(JSON.stringify(tasks) === before ? [] : [{ artifact: ARTIFACTS.subtasks, value: tasks }]),
      ...(contract === null ? [] : [{ artifact: ARTIFACTS.contract, value: contract }]),
    ];
    const line = statusLine(tasks);
    if (blocked || refusal) {
      const text = `${startedAt} ${blocked ? `subtask ${blocked.id} is ${blocked.status}` : refusal}: ${line}`;
      return { route: { to: 'block', reason: text, code: ERROR_CODES.SUBTASK_BLOCKED }, summary: text, outputs };
    }
    if (tasks.every(settled)) {
      return this.finish(run, tasks, ctx, outputs);
    }
    const waiting = tasks.some((task) => task.status === 'running') ? null : this.missing(tasks);
    const code = waiting ? ERROR_CODES.SUBTASK_WAITING : ERROR_CODES.SUBTASKS_RUNNING;
    const text = `${startedAt} ${waiting ? `${line} · waiting for ${waiting}` : line}`;
    return { route: { to: 'wait', reason: text, code }, summary: text, outputs };
  }

  /**
   * Asks the planner the questions of the first subtask that waits in research, one subtask per pass: the next
   * one is asked by the pass its answered run starts. Returns the contract with the decision, or null when none.
   */
  private async answer(ctx: StepContext, tasks: Subtask[]): Promise<string | null> {
    const { run } = ctx.opened;
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.subtasks.find(run, task.id);
      if (!child || !(await this.subtasks.asking(child))) continue;
      const contract = (await ctx.reread(ARTIFACTS.contract)) ?? '';
      const answer = await this.subtasks.answer(ctx.opened, child, task, contract);
      return answer === null ? null : withDecision(contract, task.id, answer);
    }
    return null;
  }

  /** Every task has a run, and its status follows that run. A settled task keeps the status it has. */
  private async refresh(parent: RunEntity, tasks: Subtask[]): Promise<Subtask[]> {
    const refreshed: Subtask[] = [];
    for (const task of tasks) {
      refreshed.push(settled(task) ? task : await this.follow(parent, task));
    }
    return refreshed;
  }

  private async follow(parent: RunEntity, task: Subtask): Promise<Subtask> {
    const child = await this.subtasks.open(parent, task);
    const { state } = deriveState(child);
    if (state === 'stopped') {
      // A Stop of the parent stopped this run. Resume goes on where it stopped.
      await this.subtasks.resume(child);
    }
    const status = this.statusOf(task, child, state);
    const note = status === 'green' && (await this.subtasks.withoutCi(child)) ? NO_CI_NOTE : undefined;
    return { ...task, status, note };
  }

  private statusOf(task: Subtask, child: RunEntity, state: string): Subtask['status'] {
    if (child.status === 'done') return 'green';
    if (state === 'blocked' || state === 'failed') return 'blocked';
    const launched = child.status !== 'waiting' || child.currentStep !== 'requirements';
    return task.status === 'running' || launched ? 'running' : 'waiting';
  }

  /** Starts the tasks whose dependencies are merged or skipped, up to `SUBTASKS_PARALLEL` at a time. */
  private async start(parent: RunEntity, tasks: Subtask[]): Promise<Subtask[]> {
    const ready = readyTasks(tasks, this.config.env.SUBTASKS_PARALLEL).map((task) => task.id);
    for (const task of tasks.filter((item) => ready.includes(item.id))) {
      await this.subtasks.launch(parent, task);
    }
    return tasks.map((task) => (ready.includes(task.id) ? { ...task, status: 'running', note: undefined } : task));
  }

  /** What a waiting task waits for, on the task and on its run. */
  private async explain(parent: RunEntity, tasks: Subtask[]): Promise<Subtask[]> {
    const explained: Subtask[] = [];
    for (const task of tasks) {
      const unmet = task.status === 'waiting' ? unmetDepends(task, tasks) : [];
      const note = unmet.length > 0 ? `waiting for ${unmet.join(', ')}` : undefined;
      const child = note ? await this.subtasks.find(parent, task.id) : null;
      if (child && note) await this.subtasks.waitFor(child, note);
      explained.push(task.status === 'waiting' ? { ...task, note } : task);
    }
    return explained;
  }

  /** The tasks that hold up the waiting ones, when nothing runs yet. */
  private missing(tasks: Subtask[]): string | null {
    const unmet = new Set(
      tasks.filter((task) => task.status === 'waiting').flatMap((task) => unmetDepends(task, tasks)),
    );
    return unmet.size > 0 ? [...unmet].join(', ') : null;
  }

  /** Every task is merged or skipped: the checks run on the feature branch, and implement-improve is skipped. */
  private async finish(
    run: RunEntity,
    tasks: Subtask[],
    ctx: StepContext,
    outputs: StepResult['outputs'],
  ): Promise<StepResult> {
    const next = (await this.flows.activePhases(run.id)).includes('checks') ? 'checks' : 'code-review';
    await this.flows.noteFlow(
      run.key,
      next === 'checks' ? ['checks', 'code-review', 'ci'] : ['code-review', 'ci'],
      next,
    );
    const body = `${tasks.map((task) => `- ${task.title} (${task.status})`).join('\n')}\n`;
    return {
      route: { to: 'jump', step: next },
      summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}`,
      outputs: [...outputs, { artifact: ARTIFACTS.implementation, value: body }],
      handoff: `- ${statusLine(tasks)}\n`,
    };
  }
}

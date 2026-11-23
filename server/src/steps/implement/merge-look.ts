import type { RunEntity } from '../../history/entities';
import type { AppConfig } from '../../config/env';
import type { Requirement } from '../../contract/requirement-list';
import type { Subtask } from '../../contract/subtask';
import { starterAnswer, type StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import { implementStart } from '../shared/look-start';
import type { MergeMarks } from '../shared/merge-marks';
import type { PlanConversation } from '../shared/plan-conversation';
import { StartRefused } from '../shared/start-refused';
import { mergedOf } from '../shared/subtask-status';
import type { SubtaskOps } from '../shared/subtask-ops';
import type { StepContext } from '../base-step';
import type { InputReader } from '../contract/input-reader';
import { ARTIFACTS } from '../contract/artifacts';
import { mergeLookPrompt } from './merge-look.prompts';
import { applyStarterAnswer, NOT_STARTED, type StarterState } from './starter-actions';

/** One look at a merged task, as `merge_look` stores it. */
interface Look {
  task: string;
  marks: string[];
  at: string;
}

/**
 * What the look leaves of a pass: the contract and tasks as they are now, and the new `merge_look` value, or null when no look was made.
 * When the door refused a visit, the pass stopped there: `refused` says why, and the refused task has no look yet.
 */
interface LookPass {
  contract: string;
  tasks: Subtask[];
  looks: string | null;
  refused?: StartRefused;
}

/** What the look reads and asks through. */
interface MergeLookDeps {
  subtasks: SubtaskOps;
  reader: InputReader;
  marks: MergeMarks;
  config: AppConfig;
  conversation?: PlanConversation;
}

/** The planner's answer is refused when it waits for something, or when its actions are refused as an answer to a subtask is. */
function lookErrors(state: StarterState, answer: StarterAnswerResult, at: string, source: string): string[] {
  const wait = answer.waitFor?.length ? ['waitFor: the merged task waits for nothing'] : [];
  return [...wait, ...applyStarterAnswer(state, answer, at, source).errors];
}

/**
 * The parent's look at the tasks that merged. For each merged task with no look yet, the server marks what differs
 * from its plan; the parent's planner is asked in its own chat when there is a mark or the setting says every merge,
 * and its actions change the tasks that have not started. The look is recorded per task, so a replay does not visit twice.
 */
export class MergeLook {
  constructor(private readonly deps: MergeLookDeps) {}

  /** True when a merged task has no look yet, so a pass has to run. */
  async pending(parent: RunEntity, tasks: Subtask[]): Promise<boolean> {
    return this.unlooked(tasks, await this.stored(parent.key)).length > 0;
  }

  async run(ctx: StepContext, tasks: Subtask[], contract: string, requirements: Requirement[]): Promise<LookPass> {
    const { run, startedAt } = ctx.opened;
    const stored = await this.stored(run.key);
    const due = this.unlooked(tasks, stored);
    if (due.length === 0) return { contract, tasks, looks: null };
    const looks = [...stored];
    let current = { contract, tasks };
    for (const task of due) {
      const child = await this.deps.subtasks.find(run, task.id);
      const marks = child ? await this.deps.marks.subtaskMarks(child.key, task) : [];
      if (marks.length > 0 || this.deps.config.env.EPIC_REPLAN_EVERY_MERGE) {
        const state = { ...current, requirements, asker: task.id };
        const visited = await this.visit(ctx, { task, child, marks }, state);
        if (visited instanceof StartRefused) {
          return { ...current, looks: looks.length > stored.length ? JSON.stringify(looks) : null, refused: visited };
        }
        current = visited ?? current;
      }
      looks.push({ task: task.id, marks, at: startedAt });
    }
    return { ...current, looks: JSON.stringify(looks) };
  }

  private async stored(key: string): Promise<Look[]> {
    return JSON.parse((await this.deps.reader.reread(key, ARTIFACTS.mergeLook)) || '[]') as Look[];
  }

  private unlooked(tasks: Subtask[], stored: Look[]): Subtask[] {
    return tasks.filter((task) => task.status === 'merged' && !stored.some((look) => look.task === task.id));
  }

  /** One visit of the parent's planner for a merged task. Null, with nothing changed, when it gave no usable answer; the refusal when the door did not start it. */
  private async visit(
    ctx: StepContext,
    merged: { task: Subtask; child: RunEntity | null; marks: string[] },
    state: StarterState,
  ): Promise<{ contract: string; tasks: Subtask[] } | StartRefused | null> {
    const { conversation, subtasks } = this.deps;
    const { run, startedAt } = ctx.opened;
    const { task, child, marks } = merged;
    if (!conversation) return null;
    const source = `Task ${task.id} merged`;
    const summary = child ? await subtasks.mergeSummary(child) : '';
    const commits = Object.entries((child && mergedOf(child)) ?? {})
      .filter(([, sha]) => sha)
      .map(([repo, sha]) => `${repo}=${sha}`);
    const notStarted = state.tasks.filter((item) => NOT_STARTED.includes(item.status));
    const turn = { id: `merge-look-${task.id}`, at: startedAt, text: marks.join('\n') };
    const visit = await conversation.ordered(run.key, turn, () =>
      conversation.visit(
        ctx.opened,
        (received) => mergeLookPrompt({ task, summary, marks }, state.contract, notStarted, received),
        starterAnswer,
        (value) => lookErrors(state, value as StarterAnswerResult, startedAt, source),
        [task.id, task.title, ...commits, summary, ...marks],
        implementStart(ctx.options),
      ),
    );
    if (!visit) return null;
    if ('refused' in visit) return visit.refused;
    const applied = applyStarterAnswer(state, visit.value as StarterAnswerResult, startedAt, source);
    await subtasks.recordRevisions(run, applied.changes, startedAt);
    return { contract: applied.contract, tasks: applied.tasks };
  }
}

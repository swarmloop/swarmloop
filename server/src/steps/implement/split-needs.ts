import type { RunEntity } from '../../history/entities';
import { settled, type Subtask } from '../../contract/subtask';
import { withDecisions } from '../plan/plan-tasks';
import { refusal } from './need-refusal';
import { withDecision } from '../shared/handoff';
import type { Need } from '../shared/needs';
import type { SubtaskOps } from '../shared/subtask-ops';
import type { OpenedStep } from '../step-run';
import type { StoredQuestion } from '../shared/question-parts';
import { askedQuestion } from './split-questions';

/** What a pass does for the needs of one task. */
type Action = 'wait' | 'ask' | 'question' | 'edge' | 'rerun';

function refusalLine(need: Need, reason: string): string {
  return `${need.id} cannot go first: ${reason}. Do the part your task needs inside your task, or keep the current shape and write it as not built.`;
}

/**
 * What a pass does for the needs of a task. A need that cannot be waited for goes to the planner as a refusal, except
 * one that names no task or a task settled before the need was written: that is a decision, so a question.
 */
function actionFor(task: Subtask, needs: Need[], tasks: Subtask[], early: ReadonlySet<string>): Action {
  const unknown = (need: Need): boolean => !tasks.some((item) => item.id === need.id);
  if (needs.some((need) => !unknown(need) && refusal(task, need, tasks) !== null)) return 'ask';
  if (needs.some((need) => unknown(need) || early.has(need.id))) return 'question';
  if (needs.some((need) => !task.depends.includes(need.id))) return 'edge';
  const done = needs.every((need) => tasks.some((item) => item.id === need.id && settled(item)));
  return done ? 'rerun' : 'wait';
}

interface NeedsPass {
  tasks: Subtask[];
  /** The contract with the decisions this pass added, or the contract it was given. */
  contract: string;
  /** The questions this pass puts to the person who started the run. */
  asks: StoredQuestion[];
}

/**
 * The parent's side of `needs:`: the one place that turns what a subtask asked for into a dependency edge, a decision
 * and a wait, and that ends the wait when the sibling is merged. The subtask itself only waits.
 */
export class SplitNeeds {
  constructor(private readonly subtasks: SubtaskOps) {}

  /** True when a pass has something to do for the needs of an open task. A task that only waits for a sibling needs no pass. */
  async pending(parent: RunEntity, tasks: Subtask[]): Promise<boolean> {
    for (const { task, needs, early } of await this.asking(parent, tasks)) {
      if (actionFor(task, needs, tasks, early) !== 'wait') return true;
    }
    return false;
  }

  /** How many open tasks wait for a sibling. They hold no slot: the sibling may be one that has not started. */
  async waiting(parent: RunEntity, tasks: Subtask[]): Promise<number> {
    const asking = await this.asking(parent, tasks);
    return asking.filter(({ task, needs, early }) => actionFor(task, needs, tasks, early) === 'wait').length;
  }

  /** Tasks in `waiting` have a question open for the person, so they are left alone. */
  async run(opened: OpenedStep, tasks: Subtask[], contract: string, waiting: string[]): Promise<NeedsPass> {
    let current: NeedsPass = { tasks, contract, asks: [] };
    for (const { task, child, needs, early } of await this.asking(opened.run, tasks)) {
      if (waiting.includes(task.id)) continue;
      const live = current.tasks.find((item) => item.id === task.id) ?? task;
      const action = actionFor(live, needs, current.tasks, early);
      if (action === 'ask') current = await this.ask(opened, current, live, child, needs);
      if (action === 'question') current = await this.question(opened, current, live, child, needs);
      if (action === 'edge' || action === 'rerun') current = await this.accept(opened.run, current, live, child, needs);
    }
    return current;
  }

  /**
   * The open tasks that stopped a step with needs, each with its run, its needs and the ids of the needs whose task was
   * settled when the needs were written.
   */
  private async asking(parent: RunEntity, tasks: Subtask[]) {
    const found: { task: Subtask; child: RunEntity; needs: Need[]; early: Set<string> }[] = [];
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.subtasks.find(parent, task.id);
      const needs = child?.status === 'waiting' ? await this.subtasks.needsOf(child) : [];
      if (child && needs.length > 0)
        found.push({ task, child, needs, early: await this.settledBefore(parent, child, needs, tasks) });
    }
    return found;
  }

  /** The needs that name a task that was merged or skipped no later than the needs were written. */
  private async settledBefore(
    parent: RunEntity,
    child: RunEntity,
    needs: Need[],
    tasks: Subtask[],
  ): Promise<Set<string>> {
    const early = new Set<string>();
    const named = needs.filter((need) => tasks.some((item) => item.id === need.id && settled(item)));
    if (named.length === 0) return early;
    const written = await this.subtasks.needsWrittenAt(child);
    if (written === null) return early;
    for (const need of named) {
      const at = await this.subtasks.settledAt(parent, need.id);
      if (at !== null && at <= written) early.add(need.id);
    }
    return early;
  }

  /**
   * A decision written as a need goes up the planners' chain as a question, from the planner of the parent. A usable
   * answer reruns the task as the start of the planner that gave it. With none the question is the person's, and the
   * task waits for the answer, which reaches it through the parent's questions.
   */
  private async question(
    opened: OpenedStep,
    pass: NeedsPass,
    task: Subtask,
    child: RunEntity,
    needs: Need[],
  ): Promise<NeedsPass> {
    const text = needs.map((need) => `${task.id} needs ${need.id}: ${need.what}`).join('\n');
    const { level, answer } = await this.subtasks.askUp(child, { from: 'implement', text }, 1);
    if (answer === null) return { ...pass, asks: [...pass.asks, askedQuestion(task.id, text, opened.startedAt)] };
    await this.subtasks.rerun(child, [answer], { by: 'planner', level });
    return { ...pass, contract: withDecision(pass.contract, task.id, answer) };
  }

  /**
   * A need that cannot be waited for goes to the planner as a question. The first refusal of a task reruns it with the
   * reason, and with the planner's answer when there is one. The same task asking again goes up the chain: a usable
   * answer of the planner goes down as a decision, and with none the question is put to the person who started the run.
   */
  private async ask(
    opened: OpenedStep,
    pass: NeedsPass,
    task: Subtask,
    child: RunEntity,
    needs: Need[],
  ): Promise<NeedsPass> {
    const reasons = needs.map((need) => ({ need, reason: refusal(task, need, pass.tasks) }));
    const question = reasons
      .map(({ need, reason }) => `${task.id} needs ${need.id}: ${need.what}. ${reason ?? 'It can be waited for.'}`)
      .join('\n');
    const answer = await this.subtasks.askAbout(opened, task, question, pass.contract);
    const refused = reasons.flatMap(({ need, reason }) =>
      reason === null ? [] : [{ need, line: refusalLine(need, reason) }],
    );
    const before = refused.some(({ need }) =>
      pass.contract.includes(`- subtask ${task.id}: ${need.id} cannot go first:`),
    );
    if (before && answer === null)
      return { ...pass, asks: [...pass.asks, askedQuestion(task.id, question, opened.startedAt)] };
    const lines = [...(before ? [] : refused.map(({ line }) => line)), ...(answer === null ? [] : [answer])];
    await this.subtasks.rerun(child, lines);
    return { ...pass, contract: lines.reduce((text, line) => withDecision(text, task.id, line), pass.contract) };
  }

  /** Adds the edges of a valid need, with one decision line each. When every sibling is settled the task catches up and goes on. */
  private async accept(
    parent: RunEntity,
    pass: NeedsPass,
    task: Subtask,
    child: RunEntity,
    needs: Need[],
  ): Promise<NeedsPass> {
    const added = needs.filter((need) => !task.depends.includes(need.id));
    const depends = [...task.depends, ...added.map((need) => need.id)];
    const tasks = pass.tasks.map((item) => (item.id === task.id ? { ...item, depends } : item));
    const contract = withDecisions(
      pass.contract,
      added.map((need) => `${task.id} depends on ${need.id}: ${need.what}`),
    );
    if (actionFor({ ...task, depends }, needs, tasks, new Set()) === 'rerun') {
      await this.subtasks.catchUp(parent, child);
      await this.subtasks.rerun(child, await this.lines(parent, tasks, needs));
    }
    return { ...pass, tasks, contract };
  }

  private async lines(parent: RunEntity, tasks: Subtask[], needs: Need[]): Promise<string[]> {
    const lines: string[] = [];
    for (const need of needs) {
      const sibling = tasks.find((item) => item.id === need.id);
      const run = await this.subtasks.find(parent, need.id);
      const text =
        sibling?.status === 'skipped' ? (sibling.note ?? '') : run ? await this.subtasks.mergeSummary(run) : '';
      const word = sibling?.status === 'skipped' ? 'skipped' : 'merged';
      lines.push(text.trim() ? `${need.id} ${word}: ${text.trim().replace(/\s*\n\s*/g, ' ')}` : `${need.id} ${word}`);
    }
    return lines;
  }
}

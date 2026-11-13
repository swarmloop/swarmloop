import type { RunEntity } from '../../history/entities';
import { settled, type Subtask } from '../../contract/subtask';
import { DECIDE_YOURSELF } from '../plan/plan.prompts';
import { reaches, withDecisions } from '../plan/plan-tasks';
import { withDecision } from '../shared/handoff';
import type { Need } from '../shared/needs';
import type { SubtaskOps } from '../shared/subtask-ops';
import type { OpenedStep } from '../step-run';

/** What a pass does for the needs of one task. */
type Action = 'wait' | 'ask' | 'edge' | 'rerun';

/** Why a need cannot be waited for, or null when the task may wait for it. */
function refusal(task: Subtask, need: Need, tasks: Subtask[]): string | null {
  if (need.id === task.id) return `${need.id} is this task itself`;
  if (!tasks.some((item) => item.id === need.id)) return `no task has the id ${need.id}`;
  if (reaches(tasks, need.id, task.id)) return `${need.id} depends on ${task.id}, so waiting for it would never end`;
  return null;
}

function actionFor(task: Subtask, needs: Need[], tasks: Subtask[]): Action {
  if (needs.some((need) => refusal(task, need, tasks) !== null)) return 'ask';
  if (needs.some((need) => !task.depends.includes(need.id))) return 'edge';
  const done = needs.every((need) => tasks.some((item) => item.id === need.id && settled(item)));
  return done ? 'rerun' : 'wait';
}

interface NeedsPass {
  tasks: Subtask[];
  /** The contract with the decisions this pass added, or the contract it was given. */
  contract: string;
}

/**
 * The parent's side of `needs:`: the one place that turns what a subtask asked for into a dependency edge, a decision
 * and a wait, and that ends the wait when the sibling is merged. The subtask itself only waits.
 */
export class SplitNeeds {
  constructor(private readonly subtasks: SubtaskOps) {}

  /** True when a pass has something to do for the needs of an open task. A task that only waits for a sibling needs no pass. */
  async pending(parent: RunEntity, tasks: Subtask[]): Promise<boolean> {
    for (const { task, needs } of await this.asking(parent, tasks)) {
      if (actionFor(task, needs, tasks) !== 'wait') return true;
    }
    return false;
  }

  /** How many open tasks wait for a sibling. They hold no slot: the sibling may be one that has not started. */
  async waiting(parent: RunEntity, tasks: Subtask[]): Promise<number> {
    const asking = await this.asking(parent, tasks);
    return asking.filter(({ task, needs }) => actionFor(task, needs, tasks) === 'wait').length;
  }

  async run(opened: OpenedStep, tasks: Subtask[], contract: string): Promise<NeedsPass> {
    let current = { tasks, contract };
    for (const { task, child, needs } of await this.asking(opened.run, tasks)) {
      const live = current.tasks.find((item) => item.id === task.id) ?? task;
      const action = actionFor(live, needs, current.tasks);
      if (action === 'ask') current = await this.ask(opened, current, live, child, needs);
      if (action === 'edge' || action === 'rerun') current = await this.accept(opened.run, current, live, child, needs);
    }
    return current;
  }

  /** The open tasks that stopped a step with needs, each with its run and its needs. */
  private async asking(parent: RunEntity, tasks: Subtask[]) {
    const found: { task: Subtask; child: RunEntity; needs: Need[] }[] = [];
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.subtasks.find(parent, task.id);
      const needs = child?.status === 'waiting' ? await this.subtasks.needsOf(child) : [];
      if (child && needs.length > 0) found.push({ task, child, needs });
    }
    return found;
  }

  /** A need that cannot be waited for goes to the planner as a question. The answer is a decision and ends the wait. */
  private async ask(
    opened: OpenedStep,
    pass: NeedsPass,
    task: Subtask,
    child: RunEntity,
    needs: Need[],
  ): Promise<NeedsPass> {
    const question = needs
      .map(
        (need) =>
          `${task.id} needs ${need.id}: ${need.what}. ${refusal(task, need, pass.tasks) ?? 'It can be waited for.'}`,
      )
      .join('\n');
    const answer = await this.subtasks.askAbout(opened, task, question, pass.contract);
    await this.subtasks.rerun(child, [answer ?? DECIDE_YOURSELF]);
    return { ...pass, contract: answer === null ? pass.contract : withDecision(pass.contract, task.id, answer) };
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
    if (actionFor({ ...task, depends }, needs, tasks) === 'rerun') {
      await this.subtasks.catchUp(parent, child);
      await this.subtasks.rerun(child, await this.lines(parent, tasks, needs));
    }
    return { tasks, contract };
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

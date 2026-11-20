import type { RunEntity } from '../../history/entities';
import { settled, type Subtask } from '../../contract/subtask';
import type { Requirement } from '../../contract/requirement-list';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import type { OutOfScope, StarterDecision } from '../../agent-result/definitions/starter-fields';
import { withDecision } from '../shared/handoff';
import type { StoredQuestion } from '../shared/question-parts';
import type { SubtaskOps } from '../shared/subtask-ops';
import type { StepContext } from '../base-step';
import type { InputReader } from '../contract/input-reader';
import { ARTIFACTS } from '../contract/artifacts';
import { applyStarterAnswer } from './starter-actions';
import { askedQuestion } from './split-questions';

/** One attempt's report of a subtask, as `starter_report` stores it. */
interface Report {
  key: string;
  decisions: StarterDecision[];
  outOfScope: OutOfScope[];
}

/** What the inbox leaves of a pass: the contract and tasks as they are now, the asks for the person, and the reports taken. */
export interface InboxPass {
  contract: string;
  tasks: Subtask[];
  asks: StoredQuestion[];
  /** The reports taken so far, or null when this pass took none. */
  taken: string[] | null;
}

/** What the answers of the planner act on: the contract, the task list and the requirements. */
interface InboxState {
  tasks: Subtask[];
  contract: string;
  requirements: Requirement[];
}

/** What one pass over the subtasks reads from them. */
interface StarterInboxDeps {
  subtasks: SubtaskOps;
  reader: InputReader;
}

/**
 * What the parent takes from its subtasks in a pass. The decisions they report go into the contract, each once and
 * without asking anyone. The planner of the parent is asked the questions of the first subtask that waits, one per pass:
 * its decision goes to the subtask, and its actions change the contract and the task list. When the planner gives no
 * usable answer, the question goes to the person who started the run.
 */
export class StarterInbox {
  constructor(private readonly deps: StarterInboxDeps) {}

  async take(ctx: StepContext, tasks: Subtask[], contract: string, waiting: string[]): Promise<InboxPass> {
    const { run, startedAt } = ctx.opened;
    const reported = await this.reports(run, tasks, contract, startedAt);
    const requirements = (await this.deps.reader.reread(run.key, ARTIFACTS.requirementList)) ?? [];
    const answered = await this.answer(ctx, { tasks, contract: reported.contract, requirements }, waiting);
    return { ...answered, taken: reported.taken };
  }

  /** True when an open subtask reported something that no pass took yet, so a pass has to run. */
  async pending(parent: RunEntity, tasks: Subtask[]): Promise<boolean> {
    return (await this.reports(parent, tasks, '', '')).taken !== null;
  }

  /** The decisions the open subtasks reported, written to the contract with the time of the pass, each report once. */
  private async reports(
    parent: RunEntity,
    tasks: Subtask[],
    contract: string,
    at: string,
  ): Promise<{ contract: string; taken: string[] | null }> {
    const stored = JSON.parse((await this.deps.reader.reread(parent.key, ARTIFACTS.starterTaken)) || '[]') as string[];
    const taken = [...stored];
    let current = contract;
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.deps.subtasks.find(parent, task.id);
      if (!child) continue;
      const body = await this.deps.reader.reread(child.key, ARTIFACTS.starterReport);
      for (const report of JSON.parse(body || '[]') as Report[]) {
        const id = `${child.key}/${report.key}`;
        if (taken.includes(id)) continue;
        taken.push(id);
        current = report.decisions.reduce(
          (text, decision) => withDecision(text, task.id, `${decision.item}: ${decision.text}`, at),
          current,
        );
      }
    }
    return { contract: current, taken: taken.length === stored.length ? null : taken };
  }

  /**
   * Asks the planner the questions of the first subtask that waits in research, plan, code review, or with what its
   * implement escalated, one subtask per pass: the next one is asked by the pass its answered run starts. A task that
   * waits for a sibling, or has a question open for the person, is left alone.
   */
  private async answer(ctx: StepContext, state: InboxState, waiting: string[]): Promise<Omit<InboxPass, 'taken'>> {
    const { run, startedAt } = ctx.opened;
    const { tasks, contract, requirements } = state;
    const idle = { contract, tasks, asks: [] };
    for (const task of tasks.filter((item) => !settled(item) && !waiting.includes(item.id))) {
      const child = await this.deps.subtasks.find(run, task.id);
      if (!child || (await this.deps.subtasks.needsOf(child)).length > 0) continue;
      if (!(await this.deps.subtasks.asking(child))) continue;
      const answer = await this.asked(ctx, child, task, state);
      if (answer === 'held') return idle;
      if (answer === null) {
        const asked = child.currentStep === 'code-review' ? ARTIFACTS.reviewQuestions : ARTIFACTS.questions;
        const questions = (await this.deps.reader.reread(child.key, asked)) ?? '';
        return { ...idle, asks: [askedQuestion(task.id, questions, startedAt)] };
      }
      const applied = applyStarterAnswer({ contract, tasks, requirements, asker: task.id }, answer, startedAt);
      await this.deps.subtasks.recordRevisions(run, applied.changes, startedAt);
      return { contract: applied.contract, tasks: applied.tasks, asks: [] };
    }
    return idle;
  }

  /**
   * The planner's answer for a subtask, or null when it gave none. An answer the subtask refused is sent again instead
   * of asked again, and `held` says it is still refused.
   */
  private async asked(
    ctx: StepContext,
    child: RunEntity,
    task: Subtask,
    state: InboxState,
  ): Promise<StarterAnswerResult | 'held' | null> {
    const { subtasks } = this.deps;
    if (subtasks.replyPending(child)) return (await subtasks.resend(child)) ?? 'held';
    const { contract, tasks, requirements } = state;
    const answer = await subtasks.answer(ctx.opened, child, task, contract, { tasks, requirements });
    return answer === null && subtasks.replyPending(child) ? 'held' : answer;
  }
}

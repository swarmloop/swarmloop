import type { RunEntity } from '../../history/entities';
import { renderQuestions } from '../research/research-record';
import { answered, openQuestions } from '../shared/answers';
import { withDecision } from '../shared/handoff';
import type { SubtaskOps } from '../shared/subtask-ops';

const PREFIX = /^Subtask (\S+) asks: /;

/**
 * The question of a subtask that the planner of the parent could not answer, in one line for the person who started
 * the run. `askedAt` is the start of the pass, so each ask is its own event and an old answer never matches a new ask.
 */
export function questionFor(taskId: string, question: string, askedAt: string): string {
  const text = question.trim().replace(/\s*\n\s*/g, ' ');
  return `Subtask ${taskId} asks: ${text} The planner gave no answer. (asked ${askedAt})`;
}

/** What the parent run does with the questions it holds for whoever started it: it sends each answer down to its subtask. */
export class SplitQuestions {
  constructor(private readonly subtasks: SubtaskOps) {}

  /** The ids of the tasks whose question has no answer yet. */
  pending(body: string, answersBody: string): string[] {
    const stored = answered(answersBody);
    return openQuestions(body, [])
      .filter((line) => !(stored.get(line) ?? '').trim())
      .flatMap((line) => this.taskOf(line) ?? []);
  }

  /**
   * Sends every answered question to its subtask: a task that waits in research gets the Answer command, a task that
   * waits with needs gets a line in its handoff. Each answer is a decision in the contract, and its question is closed.
   */
  async deliver(
    parent: RunEntity,
    contract: string,
    body: string,
    answersBody: string,
  ): Promise<{ contract: string; body: string }> {
    const stored = answered(answersBody);
    const open: string[] = [];
    let current = contract;
    for (const line of openQuestions(body, [])) {
      const answer = (stored.get(line) ?? '').trim();
      const id = this.taskOf(line);
      if (!answer || !id) {
        open.push(line);
        continue;
      }
      const child = await this.subtasks.find(parent, id);
      if (child && (await this.subtasks.asking(child))) await this.subtasks.deliverAnswer(child, answer);
      else if (child && (await this.subtasks.needsOf(child)).length > 0) await this.subtasks.rerun(child, [answer]);
      current = withDecision(current, id, answer);
    }
    return { contract: current, body: renderQuestions(open) };
  }

  private taskOf(line: string): string | null {
    return PREFIX.exec(line)?.[1] ?? null;
  }
}

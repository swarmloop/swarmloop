import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import { renderQuestions } from '../research/research-record';
import { answered, openQuestions } from '../shared/answers';
import { withDecision } from '../shared/handoff';
import { askedParts, type StoredQuestion } from '../shared/question-parts';
import type { SubtaskOps } from '../shared/subtask-ops';
import { questionTask, withoutSkipped } from '../shared/subtask-question-line';

const flat = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');

/**
 * The question of a subtask that the planner of the parent could not answer, in one line for the person who started
 * the run. With the planner's `words` of what must be decided, they follow the question. `askedAt` is the start of the pass, so each ask is its own event and an old answer never matches a new ask.
 */
export function questionFor(taskId: string, question: string, askedAt: string, words?: string): string {
  const text = flat(question);
  const said = words === undefined ? 'The planner gave no answer.' : `The planner cannot settle it: ${flat(words)}`;
  return `Subtask ${taskId} asks: ${text} ${said} (asked ${askedAt})`;
}

/** The question of a subtask with its parts, stored next to the text. */
export function askedQuestion(taskId: string, question: string, askedAt: string, words?: string): StoredQuestion {
  return {
    question: questionFor(taskId, question, askedAt, words),
    parts: askedParts(question, askedAt, { asker: `subtask:${taskId}` }),
  };
}

/** What the parent run does with the questions it holds for whoever started it: it sends each answer down to its subtask. */
export class SplitQuestions {
  constructor(private readonly subtasks: SubtaskOps) {}

  /** The ids of the tasks whose question has no answer yet. */
  pending(body: string, answersBody: string): string[] {
    const stored = answered(answersBody);
    return openQuestions(body, [])
      .filter((line) => !(stored.get(line) ?? '').trim())
      .flatMap((line) => questionTask(line) ?? []);
  }

  /**
   * Sends first every start of a part that the door refused as held, then every answered question to its subtask: a task that waits in research gets the Answer command, a task that
   * waits with needs gets a line in its handoff. A part that is held still keeps the answer, stored on it. Each answer is a decision in the contract with the time `at`, and its
   * question is closed. A question of a task that `tasks` reads skipped is dropped: it is handed to no one.
   */
  async deliver(
    parent: RunEntity,
    contract: string,
    body: string,
    answersBody: string,
    at: string,
    tasks: Subtask[],
  ): Promise<{ contract: string; body: string }> {
    for (const task of tasks) {
      const held = await this.subtasks.find(parent, task.id);
      if (held && (await this.subtasks.held(held))) await this.subtasks.sendHeld(held);
    }
    const stored = answered(answersBody);
    const open: string[] = [];
    let current = contract;
    for (const line of withoutSkipped(openQuestions(body, []), tasks)) {
      const answer = (stored.get(line) ?? '').trim();
      const id = questionTask(line);
      if (!answer || !id) {
        open.push(line);
        continue;
      }
      const child = await this.subtasks.find(parent, id);
      if (child && (await this.subtasks.asking(child))) await this.subtasks.deliverAnswer(child, answer);
      else if (child && (await this.subtasks.needsOf(child)).length > 0) await this.subtasks.rerun(child, [answer]);
      current = withDecision(current, id, answer, at);
    }
    return { contract: current, body: renderQuestions(open) };
  }
}

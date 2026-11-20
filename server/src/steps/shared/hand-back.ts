import type { OutOfScope } from '../../agent-result/definitions/starter-fields';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';

const HANDS_BACK = 'hands back';
const NEEDED = ' (the task cannot go on without it)';

/** The line a planner is asked for a part a task leaves out; it says when the task needs the part. */
export const handBackLine = (part: OutOfScope): string =>
  `${HANDS_BACK}${part.needed ? NEEDED : ''}: ${part.what.trim()}`;

/**
 * What is wrong with an answer to asks that hand a part back: the part is never dropped, so the answer assigns it to
 * a task that has not started (`changeTask`) or adds a task for it (`addTask`), and a part the asking task needs
 * comes with `waitFor`.
 */
export function handBackErrors(asked: string, answer: StarterAnswerResult): string[] {
  const lines = asked.split('\n').filter((line) => line.replace(/^- /, '').startsWith(HANDS_BACK));
  if (lines.length === 0) return [];
  const assigned = Boolean(answer.addTask?.length || answer.changeTask?.length);
  const needed = lines.some((line) => line.includes(NEEDED));
  return [
    ...(assigned
      ? []
      : ['a part handed back is never dropped: assign it with changeTask to a task that has not started, or addTask']),
    ...(needed && !answer.waitFor?.length
      ? ['the asking task needs the part: give waitFor on the task that gets it']
      : []),
  ];
}

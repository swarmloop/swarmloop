import type { Subtask } from '../../contract/subtask';

const PREFIX = /^Subtask (\S+) asks: /;

/** The id of the task a question line of the epic's `subtask_questions` is from; null for a line of another kind. */
export function questionTask(line: string): string | null {
  return PREFIX.exec(line)?.[1] ?? null;
}

/**
 * The question lines whose task is not skipped: a skipped task is asked nothing and is handed no answer. A merged task
 * may still be the subject of a question the epic asks the person, as a repeated gap is.
 */
export function withoutSkipped(lines: string[], tasks: Subtask[]): string[] {
  return lines.filter((line) => {
    const id = questionTask(line);
    return !tasks.some((task) => task.id === id && task.status === 'skipped');
  });
}

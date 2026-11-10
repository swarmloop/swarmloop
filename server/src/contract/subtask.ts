/** One task in the `subtasks` document of a parent run. */
export interface Subtask {
  id: string;
  title: string;
  description: string;
  files: string[];
  proof: string;
}

/** The kinds a subtask reads from its parent: the task list, and the decisions that bind every subtask. */
export const SUBTASKS_KIND = 'subtasks';
export const CONTRACT_KIND = 'contract';

export function parseSubtasks(body: string | null): Subtask[] {
  if (!body?.trim()) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as Subtask[]) : [];
  } catch {
    return [];
  }
}

/** A run with a parent is a subtask. */
export function isSubtask(run: { parentRunId?: number | null }): boolean {
  return typeof run.parentRunId === 'number';
}

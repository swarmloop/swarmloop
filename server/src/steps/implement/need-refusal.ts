import type { Subtask } from '../../contract/subtask';
import { reaches } from '../plan/plan-tasks';
import type { Need } from '../shared/needs';

/** Why a need cannot be waited for, or null when the task may wait for it. */
export function refusal(task: Subtask, need: Need, tasks: Subtask[]): string | null {
  if (need.id === task.id) return `${need.id} is this task itself`;
  if (!tasks.some((item) => item.id === need.id)) return `no task has the id ${need.id}`;
  if (reaches(tasks, need.id, task.id)) return `${need.id} depends on ${task.id}, so waiting for it would never end`;
  return null;
}

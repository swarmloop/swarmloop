import type { SubtaskStatus } from './subtask';

/** Where a task sits in the one task order: a person first, then running, then waiting, settled last. */
type TaskGroup = 'person' | 'running' | 'waiting' | 'settled';

const OPEN_GROUPS: readonly Exclude<TaskGroup, 'settled'>[] = ['person', 'running', 'waiting'];

const GROUPS: Record<SubtaskStatus, TaskGroup> = {
  blocked: 'person',
  running: 'running',
  green: 'running',
  waiting: 'waiting',
  pending: 'waiting',
  merged: 'settled',
  skipped: 'settled',
};

/** The group of a task from its shown status. `needsPerson` is true when its own run reads `Waiting for you`: a settled task never does. */
export function taskGroup(status: SubtaskStatus, needsPerson = false): TaskGroup {
  return needsPerson && GROUPS[status] !== 'settled' ? 'person' : GROUPS[status];
}

/** The tasks in the order the run list and the run page share: open groups first, the input (plan) order inside each. */
export function orderTasks<T>(tasks: readonly T[], groupOf: (task: T) => TaskGroup): { open: T[]; settled: T[] } {
  return {
    open: OPEN_GROUPS.flatMap((group) => tasks.filter((task) => groupOf(task) === group)),
    settled: tasks.filter((task) => groupOf(task) === 'settled'),
  };
}

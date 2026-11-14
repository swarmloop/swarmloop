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

export function taskGroup(status: SubtaskStatus): TaskGroup {
  return GROUPS[status];
}

/** The tasks in the order the run list and the run page share: open groups first, the input (plan) order inside each. */
export function orderTasks<T>(tasks: readonly T[], groupOf: (task: T) => TaskGroup): { open: T[]; settled: T[] } {
  return {
    open: OPEN_GROUPS.flatMap((group) => tasks.filter((task) => groupOf(task) === group)),
    settled: tasks.filter((task) => groupOf(task) === 'settled'),
  };
}

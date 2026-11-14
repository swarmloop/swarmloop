import type { RunSummary } from '@contract/api';
import { orderTasks, taskGroup } from '@contract/task-order';
import type { SubtaskStatus } from '@contract/subtask';
import { runWord } from './run-word';

/** The plan status of a task run: the server's when the task is in the plan, else read from the run's own state word. */
export function statusOf(run: RunSummary): SubtaskStatus {
  if (run.task) {
    return run.task.status;
  }
  if (run.state === 'skipped') {
    return 'skipped';
  }
  switch (runWord(run).tone) {
    case 'person':
    case 'error':
      return 'blocked';
    case 'working':
      return 'running';
    case 'done':
    case 'neutral':
      return 'merged';
  }
}

/** The tasks of an epic in the shared order: plan order first, tasks outside the plan last in the incoming order. */
export function orderedTasks(tasks: RunSummary[]): { open: RunSummary[]; settled: RunSummary[] } {
  const planned = tasks.filter((run) => run.task).sort((a, b) => (a.task?.index ?? 0) - (b.task?.index ?? 0));
  const unplanned = tasks.filter((run) => !run.task);
  return orderTasks([...planned, ...unplanned], (run) => taskGroup(statusOf(run)));
}

/** How many tasks are in each status: the plan's counts, or the listed task runs when the payload has none. */
export function taskCountsOf(parent: RunSummary, tasks: RunSummary[]): Partial<Record<SubtaskStatus, number>> {
  if (parent.taskCounts) {
    return parent.taskCounts;
  }
  const counts: Partial<Record<SubtaskStatus, number>> = {};
  for (const run of tasks) {
    const status = statusOf(run);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** Whether a listed task needs a person or has failed: the group then opens by itself. */
export function needsLook(run: RunSummary): boolean {
  const tone = runWord(run).tone;
  return tone === 'person' || tone === 'error';
}

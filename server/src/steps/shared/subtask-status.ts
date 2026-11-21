import { storedState, readOutcome } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import { settled, type Subtask, type SubtaskStatus } from '../../contract/subtask';

/** The status of a task that its run gives. A run whose merge is recorded is merged, whoever merged it. */
export function taskStatusOf(task: Subtask, child: RunEntity): SubtaskStatus {
  const { state } = storedState(child);
  if (state === 'merged') return 'merged';
  if (child.status === 'done') return 'green';
  if (state === 'blocked' || state === 'failed') return 'blocked';
  const launched = child.status !== 'waiting' || child.currentStep !== 'requirements';
  return task.status === 'running' || launched ? 'running' : 'waiting';
}

/** The merge commit per repository that the merge outcome of a run records; a merge without a sha gives ''. */
export function mergedOf(child: RunEntity): Record<string, string> | undefined {
  const outcome = readOutcome(child.mergeOutcome);
  if (!outcome || !('merged' in outcome)) return undefined;
  return Object.fromEntries(Object.entries(outcome.merged).map(([repo, fact]) => [repo, fact.sha ?? '']));
}

/** True when the task is not settled and its run gives it another status than the document does. */
export function disagrees(task: Subtask, child: RunEntity): boolean {
  return !settled(task) && taskStatusOf(task, child) !== task.status;
}

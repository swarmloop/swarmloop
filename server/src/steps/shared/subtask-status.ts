import { storedState, readOutcome } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import { settled, type Subtask, type SubtaskStatus } from '../../contract/subtask';
import type { TaskMove } from './subtask-ops';

/**
 * The status of a task that its run gives. A task whose move is queued or running is running, in any state of its
 * run, because its worktrees are not on the new tip yet. Otherwise a run whose merge is recorded is merged, whoever
 * merged it, and a blocked or failed run is blocked, with a failed move or none.
 */
export function taskStatusOf(task: Subtask, child: RunEntity, move: TaskMove | null = null): SubtaskStatus {
  if (move?.kind === 'moving') return 'running';
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

const MOVING_NOTE = "moving onto the epic's new tip";

/** What the epic says of a task that it reads by its move. */
export function moveNote(move: TaskMove): string {
  return move.kind === 'moving' ? MOVING_NOTE : `its move onto the epic's new tip failed: ${move.reason}`;
}

/**
 * True when the task is not settled and its run gives it another status than the document does, or the document
 * still says the task is moving after its move has ended: the end of a move may leave the run's status as it was.
 */
export function disagrees(task: Subtask, child: RunEntity, move: TaskMove | null = null): boolean {
  if (settled(task)) return false;
  return taskStatusOf(task, child, move) !== task.status || (move === null && task.note === MOVING_NOTE);
}

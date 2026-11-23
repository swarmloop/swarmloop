import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../../contract/error-codes';
import type { RunEntity } from '../../history/entities';
import { storedState } from '../../history/run-state';

/** Between passes: the parent waits for its subtasks, or a blocked subtask stopped it. */
export function betweenPasses(parent: RunEntity): boolean {
  const { state, reason } = storedState(parent);
  const code = reason?.code ?? '';
  return (
    parent.currentStep === 'implement' &&
    ((state === 'waiting' && SUBTASK_WAIT_CODES.some((wait) => wait === code)) ||
      (state === 'blocked' && code === ERROR_CODES.SUBTASK_BLOCKED))
  );
}

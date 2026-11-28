import { ERROR_CODES } from '../../contract/error-codes';
import { nextTryAt } from '../../contract/outside-waits';

/** How long after a refused move the next try happens. */
const SUBTASKS_WAIT_MS = 2 * 60_000;

/** The wait of an automatic rebase that the epic's running parts hold back, with its next try. */
export function subtasksWait(now: number): {
  code: typeof ERROR_CODES.CI_NOT_STARTED;
  message: string;
  retryAt: string;
} {
  const retryAt = nextTryAt(now, SUBTASKS_WAIT_MS);
  return {
    code: ERROR_CODES.CI_NOT_STARTED,
    message: `automatic rebase waits for the epic's tasks to settle; next try at ${retryAt}`,
    retryAt,
  };
}

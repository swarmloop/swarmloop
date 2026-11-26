import { ERROR_CODES } from '../../contract/error-codes';
import { outsideWaitOf } from '../../contract/outside-waits';

/** What a failed try says: a code host's outage names its own next try, any other error names the next tick. */
export function tryNote(error: unknown): string {
  const wait = outsideWaitOf(error);
  if (wait?.code === ERROR_CODES.HOST_UNAVAILABLE) return wait.message;
  const reason = error instanceof Error ? error.message : String(error);
  return `${reason}; next try on the next tick`;
}

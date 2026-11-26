import { ERROR_CODES } from '../../../contract/error-codes';
import { outsideWaitOf } from '../../../contract/outside-waits';

/** How a turn ended: its actions are applied, or it waits and tries again at `resumesAt`. */
export type TurnOutcome = { status: 'done' } | { status: 'waiting'; reason: string; resumesAt: string };

/**
 * The one rule for which ends of a turn are a wait, not a failure: a usage limit of every agent and a host that does
 * not answer, read from the table of outside waits. Any other error gives null.
 */
export function waitOf(error: unknown): Extract<TurnOutcome, { status: 'waiting' }> | null {
  const wait = outsideWaitOf(error);
  if (wait?.code !== ERROR_CODES.RUNTIME_LIMIT && wait?.code !== ERROR_CODES.HOST_UNAVAILABLE) return null;
  return wait.retryAt === null ? null : { status: 'waiting', reason: wait.message, resumesAt: wait.retryAt };
}

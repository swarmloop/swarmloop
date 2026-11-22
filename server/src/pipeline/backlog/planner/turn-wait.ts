import { HostUnavailable, RuntimeLimit } from '../../../core/swarmloop-error';

/** How a turn ended: its actions are applied, or it waits and tries again at `resumesAt`. */
export type TurnOutcome = { status: 'done' } | { status: 'waiting'; reason: string; resumesAt: string };

/**
 * The one rule for which ends of a turn are a wait, not a failure: a usage limit of every agent and a code host that
 * does not answer. Any other error gives null.
 */
export function waitOf(error: unknown): Extract<TurnOutcome, { status: 'waiting' }> | null {
  if (error instanceof RuntimeLimit) return { status: 'waiting', reason: error.message, resumesAt: error.resumesAt };
  if (error instanceof HostUnavailable) return { status: 'waiting', reason: error.message, resumesAt: error.retryAt };
  return null;
}

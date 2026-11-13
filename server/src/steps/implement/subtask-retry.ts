import { ERROR_CODES } from '../../contract/error-codes';
import type { RunEntity } from '../../history/entities';
import { deriveState } from '../../history/run-state';

const RETRY_CODES: readonly string[] = [
  ERROR_CODES.HOST_UNAVAILABLE,
  ERROR_CODES.CI_NOT_STARTED,
  ERROR_CODES.DOCKER_UNAVAILABLE,
];

/** When a subtask run that waits on a host or docker outage tries again; null for any other run. */
function retryAtOf(child: RunEntity): string | null {
  const { state, reason } = deriveState(child);
  return state === 'waiting' && reason?.retryAt && RETRY_CODES.includes(reason.code) ? reason.retryAt : null;
}

/** The earliest next try of the given subtask runs, or null when none waits on an outage. */
export function earliestRetry(children: RunEntity[]): string | null {
  const times = children.flatMap((child) => retryAtOf(child) ?? []);
  return times.length === 0
    ? null
    : times.reduce((first, time) => (Date.parse(time) < Date.parse(first) ? time : first));
}

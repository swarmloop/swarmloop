import type { SwarmloopEnv } from '../config/env';
import type { Clock } from '../core/clock';
import { ERROR_CODES, IMAGE_ERROR_CODES } from '../contract/error-codes';
import { GitAuthError, HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { ChecksStopped } from '../environment/check-pool';
import { StepStopped } from '../agent/step-stopped';

/** How a step that threw ends without failing: the run is blocked or waits, as the error says. */
interface ErrorEnd {
  outcome: 'blocked' | 'waiting';
  exitCode: number;
  line: string;
  code?: string;
  retryAt?: string;
}

/** The wait of a docker that does not answer: its code, text and next try. */
export function dockerWait(
  clock: Clock,
  env: Pick<SwarmloopEnv, 'RECONCILE_MS'>,
): { code: string; message: string; retryAt: string } {
  const retryAt = new Date(clock.now() + env.RECONCILE_MS).toISOString();
  return { code: ERROR_CODES.DOCKER_UNAVAILABLE, message: `docker did not answer; next try at ${retryAt}`, retryAt };
}

/** The code, text and next try of a passing outage: a host that did not answer or a docker that is down. Null for any other error. */
export function waitingEnd(
  error: unknown,
  clock: Clock,
  env: Pick<SwarmloopEnv, 'RECONCILE_MS'>,
): { code: string; message: string; retryAt: string } | null {
  if (error instanceof HostUnavailable) {
    return { code: error.code, message: error.message, retryAt: error.retryAt };
  }
  if (error instanceof SwarmloopError && error.code === ERROR_CODES.DOCKER_UNAVAILABLE) {
    return dockerWait(clock, env);
  }
  return null;
}

/** The ending of a step whose error is not a failure: a stop, a git auth wait, a passing outage or a missing image. Null otherwise. */
export function errorEnd(
  error: unknown,
  startedAt: string,
  clock: Clock,
  env: Pick<SwarmloopEnv, 'RECONCILE_MS'>,
): ErrorEnd | null {
  if (error instanceof StepStopped || error instanceof ChecksStopped) {
    return { outcome: 'blocked', exitCode: 1, line: `${startedAt} ${error.message}` };
  }
  if (error instanceof GitAuthError) {
    return { outcome: 'waiting', exitCode: 0, line: `${startedAt} ${error.message}`, code: error.code };
  }
  const waiting = waitingEnd(error, clock, env);
  if (waiting) {
    return {
      outcome: 'waiting',
      exitCode: 0,
      line: `${startedAt} ${waiting.message}`,
      code: waiting.code,
      retryAt: waiting.retryAt,
    };
  }
  if (error instanceof SwarmloopError && IMAGE_ERROR_CODES.includes(error.code)) {
    return { outcome: 'blocked', exitCode: 1, line: `${startedAt} ${error.message}`, code: error.code };
  }
  return null;
}

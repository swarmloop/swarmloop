import { ERROR_CODES } from './error-codes';

interface OutsideWait {
  status: 'waiting' | 'blocked';
  end: 'cooldown' | 'time' | 'docker' | 'disk' | 'connection';
}

/** Every wait on something outside swarmloop, by the code of its reason. */
export const OUTSIDE_WAITS = {
  // cooldown: an agent of the run's role is free again (the cooldowns).
  [ERROR_CODES.RUNTIME_LIMIT]: { status: 'waiting', end: 'cooldown' },
  // time: the retryAt its reason names.
  [ERROR_CODES.HOST_UNAVAILABLE]: { status: 'waiting', end: 'time' },
  // time: the retryAt its reason names.
  [ERROR_CODES.CI_NOT_STARTED]: { status: 'waiting', end: 'time' },
  // docker: docker answers.
  [ERROR_CODES.DOCKER_UNAVAILABLE]: { status: 'waiting', end: 'docker' },
  // disk: free disk is at least MIN_FREE_GB.
  [ERROR_CODES.DISK_LOW]: { status: 'blocked', end: 'disk' },
  // connection: the starter's connection is ok.
  [ERROR_CODES.GIT_AUTH]: { status: 'waiting', end: 'connection' },
} as const satisfies Record<string, OutsideWait>;

interface OutsideWaitRead {
  code: string;
  message: string;
  retryAt: string | null;
}

function entryOf(code: unknown): OutsideWait | null {
  return typeof code === 'string' && Object.hasOwn(OUTSIDE_WAITS, code)
    ? OUTSIDE_WAITS[code as keyof typeof OUTSIDE_WAITS]
    : null;
}

/**
 * The next try of an outside wait: the next boundary of a fixed grid of `everyMs` after `now`. It is fixed for the
 * whole try, so a pass inside it computes the same time and writes nothing new.
 */
export function nextTryAt(now: number, everyMs: number): string {
  return new Date(Math.floor(now / everyMs) * everyMs + everyMs).toISOString();
}

/** Reads a thrown error or a stored error record as an outside wait with its next try, or null when it is none. */
export function outsideWaitOf(error: unknown): OutsideWaitRead | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, retryAt, resumesAt } = error as Record<string, unknown>;
  if (entryOf(code) === null || typeof message !== 'string') return null;
  const next = typeof retryAt === 'string' ? retryAt : typeof resumesAt === 'string' ? resumesAt : null;
  return { code: code as string, message, retryAt: next };
}

/** The table's entry of a run's reason, only when the run's status is the one that wait has. */
export function outsideWaitOfRun(status: string, code: string | null | undefined): OutsideWait | null {
  const entry = entryOf(code);
  return entry !== null && entry.status === status ? entry : null;
}

import type { Clock } from '../core/clock';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { HOST_RETRY_MS, withHostRetries, type HostRetryTiming } from '../integrations/http';
import { gitDetail, redact } from './git';

const TRANSIENT_STDERR = [
  /Could not resolve host/i,
  /Connection timed out/i,
  /Connection reset/i,
  /The requested URL returned error: 5\d\d/,
  /RPC failed/i,
  /early EOF/i,
  /remote end hung up/i,
];

/** True when git's own words say the host or the network failed for a moment: a later try may work. */
export function isTransientGitError(stderr: string): boolean {
  return TRANSIENT_STDERR.some((pattern) => pattern.test(stderr));
}

function errorText(error: unknown): string {
  return error instanceof SwarmloopError ? error.message : gitDetail(error);
}

/** The host name of a remote, never its credentials. */
function hostOf(remote: string | null): string {
  if (!remote) {
    return 'origin';
  }
  try {
    return new URL(remote).hostname || 'origin';
  } catch {
    return /@([^:/]+)[:/]/.exec(remote)?.[1] ?? 'origin';
  }
}

/** The one retry policy of git commands that reach a host: the policy of `http.ts`, told apart by stderr. */
export async function withGitHostRetries<T>(
  remote: string | null,
  clock: Clock,
  run: () => Promise<T>,
  secret?: string,
  timing?: HostRetryTiming,
): Promise<T> {
  try {
    return await withHostRetries(run, (error) => isTransientGitError(errorText(error)), timing);
  } catch (error) {
    if (!isTransientGitError(errorText(error))) {
      throw error;
    }
    const detail = redact(errorText(error), secret?.trim()).split('\n')[0].slice(0, 200);
    throw new HostUnavailable(hostOf(remote), detail, new Date(clock.now() + HOST_RETRY_MS).toISOString());
  }
}

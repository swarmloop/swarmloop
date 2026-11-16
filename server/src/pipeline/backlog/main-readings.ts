import { HostUnavailable } from '../../core/swarmloop-error';
import type { RepositoryHost } from '../../steps/shared/repository-host';
import type { MainReading } from './task-readiness';

/** What a failed read of a main says: a host outage names its next try, any other reason names the next tick. */
function unreadable(error: unknown): MainReading {
  if (error instanceof HostUnavailable) return { state: 'unreadable', note: error.message };
  const reason = error instanceof Error ? error.message : String(error);
  return { state: 'unreadable', note: `${reason}; next try on the next tick` };
}

/** Reads the main of each repository that `cache` does not hold yet, as `person`, and keeps the readings in `cache`. */
export async function readMains(
  host: Pick<RepositoryHost, 'main'>,
  repositories: string[],
  person: string,
  cache: Map<string, MainReading>,
): Promise<void> {
  for (const repo of repositories) {
    if (cache.has(repo)) continue;
    try {
      cache.set(repo, await host.main(repo, person));
    } catch (error) {
      cache.set(repo, unreadable(error));
    }
  }
}

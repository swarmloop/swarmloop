import type { RepositoryHost } from '../../steps/shared/repository-host';
import type { MainReading } from './task-readiness';
import { tryNote } from './try-note';

/** What a failed read of a main says: a host outage names its next try, any other reason names the next tick. */
function unreadable(error: unknown): MainReading {
  return { state: 'unreadable', note: tryNote(error) };
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

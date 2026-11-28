import type { RepositoryHost } from '../../steps/shared/repository-host';
import { mainPasses, type MainReading } from './task-readiness';
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

/** What a task waits with for the main of a repository, or null when the main passes or the task repairs that main. */
export function mainWaitFor(repository: string, main: MainReading | undefined, fixesMainHere: boolean): string | null {
  if (fixesMainHere || mainPasses(main)) return null;
  const base = `waits for a green main of ${repository}`;
  return main?.state === 'unreadable' ? `${base}: ${main.note}` : base;
}

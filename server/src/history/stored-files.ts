import { join } from 'path';
import { listRunEntries, runFileOwner } from '../core/run-files';
import { removeTreeAsync } from './run-paths';

/** The files in `data/` and the run folder swarmloop stored for one run, found by the one matcher of a run's files. */
export async function removeStoredFiles(root: string, key: string, keys: readonly string[]): Promise<void> {
  const known = new Set(keys);
  for (const entry of await listRunEntries(root)) {
    if (runFileOwner(entry, known)?.key === key) {
      await removeTreeAsync(join(root, 'data', entry));
    }
  }
  await removeTreeAsync(join(root, 'runs', key));
}

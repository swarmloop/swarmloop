import type { DeliveryEntry } from '../../contract/delivery';
import type { RebasedPublisher } from '../shared/rebased-publisher';
import type { Tree } from './commit-git';

/**
 * What the run delivers of each repository: `publishing` for a tree with work of its own, `read` for the rest.
 * `hasOwnWork` is the one place that decides it; the merge request step marks a repository published.
 */
export async function deliveryEntries(
  publisher: RebasedPublisher,
  trees: Tree[],
  named: string | null,
): Promise<DeliveryEntry[]> {
  const entries: DeliveryEntry[] = [];
  for (const tree of trees) {
    entries.push({ repo: tree.repo, state: (await publisher.hasOwnWork(tree, named)) ? 'publishing' : 'read' });
  }
  return entries;
}

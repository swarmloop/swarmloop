import type { DeliveryEntry } from '../../contract/delivery';
import { withPublished, withRead } from '../contract/delivery-list';
import type { Tree } from './merge-request-trees';

/**
 * The delivery list once the host answered: a repository with a request is published, one the host had nothing to
 * merge for was only read.
 */
export function deliveredList(entries: DeliveryEntry[], trees: Tree[], opened: Tree[]): DeliveryEntry[] {
  const made = new Set(opened.map((tree) => tree.repo));
  const published = withPublished(
    entries,
    opened.map(({ repo, project }) => ({ repo, project })),
  );
  return withRead(
    published,
    trees.filter((tree) => !made.has(tree.repo)).map((tree) => tree.repo),
  );
}

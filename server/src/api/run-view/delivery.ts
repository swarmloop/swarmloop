import type { DeliveryEntry, DeliveryView } from '../../contract/delivery';
import { repoNames } from '../../git/repo-names';
import { deliveryOf, parseDelivery } from '../../steps/contract/delivery-list';

function readList(body: string | null): DeliveryEntry[] | null {
  try {
    return body?.trim() ? parseDelivery(body) : null;
  } catch {
    return null;
  }
}

function readRepos(body: string | null): string[] {
  try {
    return repoNames(body ?? '');
  } catch {
    return [];
  }
}

/** What the run delivers of each repository: its stored list, or every repository of its `repos` document for a run made before the list. */
export function deliveryEntriesOf(listBody: string | null, reposBody: string | null): DeliveryEntry[] {
  return deliveryOf(readList(listBody), readRepos(reposBody));
}

/** What the run page shows: the stored list with the repository and its state, nothing of the code host. A run with no list has delivered nothing to show yet. */
export function deliveryViews(listBody: string | null): DeliveryView[] {
  return (readList(listBody) ?? []).map(({ repo, state }) => ({ repo, state }));
}

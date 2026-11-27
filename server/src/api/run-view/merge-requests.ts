import type { MergeRequestView } from '../../contract/api';
import { readOutcome } from '../../history/run-state';
import type { DeliveryEntry } from '../../contract/delivery';
import { toPublish } from '../../steps/contract/delivery-list';
import { parseMergeRequests } from '../../steps/merge-request/merge-request-record';
import type { MergeRequestLine } from '../../steps/merge-request/merge-request-record';

function readRecords(body: string | null): MergeRequestLine[] {
  if (!body?.trim()) return [];
  try {
    return parseMergeRequests(body);
  } catch {
    return [];
  }
}

/**
 * One link per repository with its state. A request is labelled with the repository whose delivery entry names its
 * project; a run made before the list has none, so its requests pair with its repositories by position.
 */
export function mergeRequestViews(
  mergeOutcome: string | null,
  mergeRequestBody: string | null,
  delivery: DeliveryEntry[],
): MergeRequestView[] {
  const records = readRecords(mergeRequestBody);
  const names = toPublish(delivery).map((entry) => entry.repo);
  const positional = records.length === names.length;
  const outcome = readOutcome(mergeOutcome);
  return records.map((record, index) => {
    const repo =
      delivery.find((entry) => entry.project === record.project)?.repo ??
      (positional ? names[index] : undefined) ??
      record.project;
    const state =
      outcome && 'merged' in outcome
        ? 'merged'
        : outcome && outcome.closed.repo === repo
          ? 'closed'
          : record.draft
            ? 'draft'
            : 'open';
    return { repo, url: record.url, state };
  });
}

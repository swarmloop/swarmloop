import type { MergeRequestView } from '../../contract/api';
import { readOutcome } from '../../history/run-state';
import { repoNames } from '../../git/repo-names';
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

function readRepos(body: string | null): string[] {
  try {
    return repoNames(body ?? '');
  } catch {
    return [];
  }
}

/** One link per repository with its state. The repository is positional in the `repos` document, as for a subtask. */
export function mergeRequestViews(
  mergeOutcome: string | null,
  mergeRequestBody: string | null,
  reposBody: string | null,
): MergeRequestView[] {
  const records = readRecords(mergeRequestBody);
  const names = readRepos(reposBody);
  const positional = records.length === names.length;
  const outcome = readOutcome(mergeOutcome);
  return records.map((record, index) => {
    const repo = (positional ? names[index] : undefined) ?? record.project;
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

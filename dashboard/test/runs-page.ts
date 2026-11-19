import type { RunSummary } from '@contract/api';
import { filterRuns, nested } from '@contract/run-list';
import type { Part, RunsPage } from '@contract/run-list';

const PAGE_SIZE = 20;

/** What the server answers for a part, a filter text and a cursor: `done` and `all` come 20 top-level runs a page. */
export function runsPage(rows: RunSummary[], query: { part: Part; q?: string; cursor?: string }): RunsPage {
  const { visible, otherMatches } = filterRuns(rows, query.q ?? '', query.part);
  const { counts } = filterRuns(rows, '', 'all');
  if (query.part === 'active') {
    return { runs: visible, counts, otherMatches, next: null };
  }
  const { tops, children } = nested(visible);
  const from = query.cursor === undefined ? 0 : Number(query.cursor);
  const page = tops.slice(from, from + PAGE_SIZE);
  const more = from + PAGE_SIZE < tops.length;
  return {
    runs: page.flatMap((top) => [top, ...(children.get(top.key) ?? [])]),
    counts,
    otherMatches,
    next: more ? String(from + PAGE_SIZE) : null,
  };
}

/** A fake `listRuns` that answers from the given rows like the server would. */
export function listRunsFrom(
  rows: RunSummary[],
): (query: { part: Part; q: string; cursor?: string }) => Promise<RunsPage> {
  return (query) => Promise.resolve(runsPage(rows, query));
}

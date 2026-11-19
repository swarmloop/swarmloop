import { parsePart, filterRuns } from '@contract/run-list';

export { filterRuns, parsePart };
export type { Part, PartCounts } from '@contract/run-list';

/** The query that keeps the chosen part across a navigation: `?show=done`, or nothing while the address has no part. */
export function showQuery(params: URLSearchParams): string {
  const show = params.get('show');
  return show === null ? '' : `?${new URLSearchParams({ show: parsePart(show) })}`;
}

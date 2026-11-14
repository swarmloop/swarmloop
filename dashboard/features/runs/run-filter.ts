import type { RunSummary } from '@contract/api';
import { nested } from './run-days';

export type Part = 'active' | 'done' | 'all';

export interface PartCounts {
  active: number;
  done: number;
  all: number;
}

const PARTS: readonly string[] = ['active', 'done', 'all'];
const DONE_STATES: readonly string[] = ['done', 'merged', 'closed', 'skipped'];

export function parsePart(value: string | null): Part {
  return PARTS.includes(value ?? '') ? (value as Part) : 'active';
}

/** The query that keeps the chosen part across a navigation: `?show=done`, or nothing while the address has no part. */
export function showQuery(params: URLSearchParams): string {
  const show = params.get('show');
  return show === null ? '' : `?${new URLSearchParams({ show: parsePart(show) })}`;
}

/** The runs to show for a part and a query, the group counts of each part, and the query's matches in the other part. */
export function filterRuns(
  runs: RunSummary[],
  query: string,
  part: Part,
): { visible: RunSummary[]; counts: PartCounts; otherMatches: number } {
  const { tops, children } = nested(runs);
  const needle = query.trim().toLowerCase();
  const matches = (run: RunSummary): boolean =>
    run.name.toLowerCase().includes(needle) || run.key.toLowerCase().includes(needle);
  const groups = tops.map((top) => {
    const tasks = children.get(top.key) ?? [];
    return {
      done: DONE_STATES.includes(top.state),
      matched: [top, ...tasks].some(matches),
      runs: [top, ...tasks],
    };
  });
  const counts = {
    active: groups.filter((group) => !group.done).length,
    done: groups.filter((group) => group.done).length,
    all: groups.length,
  };
  const inPart = (done: boolean): boolean => part === 'all' || done === (part === 'done');
  const visible = groups.filter((group) => group.matched && inPart(group.done)).flatMap((group) => group.runs);
  const otherMatches = part === 'all' ? 0 : groups.filter((group) => group.matched && !inPart(group.done)).length;
  return { visible, counts, otherMatches };
}

import type { RunSummary } from './api';

export type Part = 'active' | 'done' | 'all';

export interface PartCounts {
  active: number;
  done: number;
  all: number;
}

const PARTS: readonly string[] = ['active', 'done', 'all'];
export const DONE_STATES: readonly string[] = ['done', 'merged', 'closed', 'skipped'];

export function parsePart(value: string | null): Part {
  return PARTS.includes(value ?? '') ? (value as Part) : 'active';
}

/** The runs that are not shown under a parent, and each parent's subtasks in list order. */
export function nested(visible: RunSummary[]): { tops: RunSummary[]; children: Map<string, RunSummary[]> } {
  const keys = new Set(visible.map((run) => run.key));
  const children = new Map<string, RunSummary[]>();
  const tops: RunSummary[] = [];
  for (const run of visible) {
    if (run.parentKey && keys.has(run.parentKey)) {
      children.set(run.parentKey, [...(children.get(run.parentKey) ?? []), run]);
    } else {
      tops.push(run);
    }
  }
  return { tops, children };
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
    [run.title, run.name, run.key].some((text) => text.toLowerCase().includes(needle));
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

/** One answer of `GET /runs` and the `runs` event: whole groups (a top-level run with its subtasks) in view order. */
export interface RunsPage {
  runs: RunSummary[];
  counts: PartCounts;
  /** The visible runs of the other part that match the text. */
  otherMatches: number;
  /** The cursor of the next page, or null on the last page. */
  next: string | null;
}

/** The rows a live change touched, the keys that left the list, and the counts after it. */
export interface RunChange {
  rows: RunSummary[];
  removed: string[];
  counts: PartCounts;
}

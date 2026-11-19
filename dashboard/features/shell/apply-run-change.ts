import type { RunSummary } from '@contract/api';
import { filterRuns, nested } from '@contract/run-list';
import type { Part, RunChange } from '@contract/run-list';

/**
 * The held list after a live change: the changed rows replace or join the held ones, the rows that left are dropped,
 * and the list is ordered newest first with the held order kept inside ties. When the list is paged (`done`, `all`
 * with a next page), a group the list had not loaded and that lies beyond the loaded range is ignored.
 */
export function applyRunChange(
  held: { runs: RunSummary[]; part: Part; q: string; next: string | null },
  change: RunChange,
): RunSummary[] {
  const removed = new Set(change.removed);
  const changed = new Map(change.rows.map((row) => [row.key, row]));
  const kept = held.runs.filter((run) => !removed.has(run.key)).map((run) => changed.get(run.key) ?? run);
  const heldKeys = new Set(held.runs.map((run) => run.key));
  const added = change.rows.filter((row) => !heldKeys.has(row.key) && !removed.has(row.key));
  const candidates = [...kept, ...added].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  const { tops, children } = nested(filterRuns(candidates, held.q, held.part).visible);
  const groups = tops.map((top) => ({ top, runs: [top, ...(children.get(top.key) ?? [])] }));
  const paged = held.part !== 'active' && held.next !== null;
  const last = nested(held.runs).tops.at(-1);
  return groups
    .filter(
      (group) =>
        !paged || !last || group.runs.some((run) => heldKeys.has(run.key)) || group.top.createdAt >= last.createdAt,
    )
    .flatMap((group) => group.runs);
}

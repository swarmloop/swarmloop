import type { StatsRunRow } from '../history/stats.repository';

/**
 * The rows the statistics count: the runs without a parent, in the order they came in. Each one carries its own id and
 * the ids of its subtasks, whatever their state. A subtask whose parent is not in the rows is not counted.
 */
export function countedRunsOf(runs: StatsRunRow[]): { run: StatsRunRow; ids: number[] }[] {
  const children = new Map<number, number[]>();
  for (const run of runs) {
    const parent = run.parentRunId ?? null;
    if (parent !== null) {
      children.set(parent, [...(children.get(parent) ?? []), run.id]);
    }
  }
  return runs
    .filter((run) => (run.parentRunId ?? null) === null)
    .map((run) => ({ run, ids: [run.id, ...(children.get(run.id) ?? [])] }));
}

/** One per-id number added over the ids of a counted run. */
export function sumOver(ids: number[], of: (id: number) => number): number {
  return ids.reduce((sum, id) => sum + of(id), 0);
}

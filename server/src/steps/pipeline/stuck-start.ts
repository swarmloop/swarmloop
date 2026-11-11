import { unstartedRuns, type Seen } from './pipeline-report';

/** Whether a run has been queued without a job for longer than `limit` of awake time; `since` holds when each was first seen so. */
export function stuckAtStart(since: Map<number, number>, seen: Seen[], now: number, limit: number): boolean {
  const ids = new Set(unstartedRuns(seen).map((run) => run.id));
  for (const id of since.keys()) {
    if (!ids.has(id)) {
      since.delete(id);
    }
  }
  for (const id of ids) {
    if (!since.has(id)) {
      since.set(id, now);
    }
  }
  return [...since.values()].some((first) => now - first > limit);
}

import type { RunEntity } from '../history/entities';

/** When and how a run finished: `settled` is a run whose end is final (merged, closed, skipped), so it is freed at once. */
interface RunFinish {
  at: number;
  settled: boolean;
}

/** The states in which a run ended without a merge and a person may still resume it, unless its epic has finished. */
const ENDED_STATES: ReadonlySet<string> = new Set(['stopped', 'blocked', 'failed']);

/**
 * The one rule of finished: a run is finished when it is merged, closed, done or skipped, or when it ended without a
 * merge as a subtask whose epic is finished. Null for a run that works and for an ended run a person may still resume.
 */
export function runFinish(run: RunEntity, byId: ReadonlyMap<number, RunEntity>): RunFinish | null {
  const state = run.state ?? (run.status === 'done' ? 'done' : null);
  if (state === 'merged' || state === 'closed' || state === 'skipped') {
    return { at: finishedAt(run), settled: true };
  }
  if (state === 'done') {
    return { at: finishedAt(run), settled: false };
  }
  const parent =
    state !== null && ENDED_STATES.has(state) && run.parentRunId !== null ? byId.get(run.parentRunId) : null;
  const epic = parent ? runFinish(parent, byId) : null;
  return epic && { at: Math.max(finishedAt(run), epic.at), settled: false };
}

/** When a run finished. The merge watch's own writes move `updatedAt`, so a done run it has seen keeps its `doneAt`. */
function finishedAt(run: RunEntity): number {
  return Date.parse(run.doneAt ?? run.updatedAt);
}

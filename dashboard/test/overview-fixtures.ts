import type { FlowView, RunSummary } from '@contract/api';
import { DONE_SHOWN, type DoneLatelyItem } from '@contract/overview-done';
import { WAITS_FOR_YOU } from '@contract/eta';
import { NEEDS_ANSWERS } from '@contract/run-state';
import { flowView, runSummary } from './fixtures';

function run(key: string, overrides: Partial<RunSummary>): RunSummary {
  return { ...runSummary(), key, name: key, title: `Title of ${key}`, ...overrides };
}

/** A top-level run that works at its implementation step, with an estimate. */
export function workingRun(key: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return run(key, { eta: { leftMs: 5 * 60_000, doneAt: '2026-01-01T00:05:00.000Z' }, ...overrides });
}

/** An epic with its task counts, its totals and no estimate. */
export function epicRun(key: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return run(key, {
    taskCounts: { merged: 2, running: 1 },
    epic: { usd: 12.5, durationMs: 3_600_000 },
    ...overrides,
  });
}

/** A subtask of an epic. */
export function subtaskRun(key: string, parentKey: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return run(key, { parentKey, ...overrides });
}

/** A run a backlog's milestone holds. */
export function milestoneRun(key: string, backlog: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return workingRun(key, { backlog: { name: backlog, milestone: 3 }, ...overrides });
}

/** A run that waits for a person to answer a question. */
export function questionRun(key: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return run(key, {
    status: 'waiting',
    state: 'waiting',
    stateReason: { code: NEEDS_ANSWERS, message: 'Waiting for your answers' },
    eta: WAITS_FOR_YOU,
    ...overrides,
  });
}

/** A run that failed. */
export function failedRun(key: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return run(key, { status: 'failed', state: 'failed', ...overrides });
}

/** A merged run with its time and cost. */
export function mergedRun(key: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return run(key, {
    status: 'done',
    state: 'done',
    merge: { merged: { shop: { sha: null, by: null, at: '2026-01-01T00:00:00.000Z', url: null } } },
    usd: 1.5,
    durationMs: 12 * 3_600_000 + 4 * 60_000,
    ...overrides,
  });
}

/** A flow with the given returns, one merge request and nothing else. */
export function returnsFlow(key: string, counts: number[], url = `https://example.test/${key}/pull/1`): FlowView {
  return flowView({
    key,
    mergeRequests: url ? [{ repo: 'shop', url, state: 'merged' }] : [],
    returns: counts.map((count, index) => ({ counter: `counter-${index}`, count, from: 'checks', to: 'implement' })),
  });
}

/** The item Done lately shows for a finished run: it links to the run and counts its own returns. */
export function doneItem(run: RunSummary, overrides: Partial<DoneLatelyItem> = {}): DoneLatelyItem {
  return {
    key: run.key,
    title: run.title,
    link: { run: run.key },
    run,
    runKeys: [run.key],
    finishedAt: 0,
    durationMs: run.durationMs,
    usd: run.usd,
    milestone: false,
    ...overrides,
  };
}

/** What the server's read answers for these runs: the first five finished top-level runs. */
export function doneItemsOf(runs: RunSummary[]): DoneLatelyItem[] {
  return runs
    .filter((one) => one.status === 'done' && one.parentKey === undefined)
    .slice(0, DONE_SHOWN)
    .map((one) => doneItem(one));
}

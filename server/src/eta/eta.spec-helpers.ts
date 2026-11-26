import type { EtaTable, FinishedRunInput, LiveRun } from './eta.types';

export const MIN = 60_000;
export const NOW = '2026-11-19T12:00:00.000Z';

export const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * MIN).toISOString();

export const emptyTable = (): EtaTable => ({
  plain: { steps: {}, visits: {}, whole: null },
  epic: { steps: {}, visits: {}, whole: null },
  subtask: { steps: {}, visits: {}, whole: null },
});

export function liveRun(extra: Partial<LiveRun> = {}): LiveRun {
  return {
    kind: 'plain',
    state: 'running',
    reason: null,
    currentStep: 'implement',
    stepStartedAt: null,
    waits: [],
    ...extra,
  };
}

/** A finished run that entered `implement` at minute 10 and ended at `endMin` (minutes from NOW). */
export function finishedRun(endMin: number, extra: Partial<FinishedRunInput> = {}): FinishedRunInput {
  return {
    createdAt: at(endMin - 60),
    lastFinishedAt: at(endMin),
    mergedAt: null,
    parentRunId: null,
    epicAt: null,
    entries: [{ step: 'implement', startedAt: at(endMin - 30), finishedAt: at(endMin) }],
    waits: [],
    ...extra,
  };
}

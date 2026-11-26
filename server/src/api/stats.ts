import type { StatsDay, StatsRun, StatsShare, StatsView } from '../contract/api';
import type { StatsRows, StatsRunRow } from '../history/stats.repository';
import { limited, round, share } from './stats-groups';
import { readOutcome } from '../history/run-state';
import { runName } from './run-view/flow';
import { viewTitle } from './run-view/run-title';
import { localDay, MINUTE_MS } from './local-day';
import { stallsOf } from './stats-stalls';
import { personMessagesOf } from './stats-person';
import { requirementsOf } from './stats-requirements';
import { spendOf } from './stats-spend';
import { returnsOf } from './stats-returns';
import { countedRunsOf, median, outcomeOf, subtaskTasksOf, sumOver, unitsOf } from './stats-units';

export { localDay, outcomeOf };

const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_BUCKETS = ['0', '1', '2', '3', '4+'];

/** The last `days` local days, or every day when `days` is 0. Either way the days start no earlier than the first run. */
export interface StatsRange {
  days: number;
  /** Minutes the viewer's clock is behind UTC, as `Date.getTimezoneOffset` gives them (Warsaw in winter: -60). */
  tzOffset: number;
}

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC time the first day of the range starts at, or null for every run. */
export function rangeStart(now: number, range: StatsRange): string | null {
  if (range.days <= 0) {
    return null;
  }
  const first = shiftDay(localDay(now, range.tzOffset), 1 - range.days);
  return new Date(Date.parse(`${first}T00:00:00Z`) + range.tzOffset * MINUTE_MS).toISOString();
}

function emptyDays(from: string, to: string): Map<string, StatsDay> {
  const days = new Map<string, StatsDay>();
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    days.set(day, {
      day,
      done: 0,
      active: 0,
      failed: 0,
      epics: { done: 0, active: 0, failed: 0 },
      tasks: { done: 0, active: 0, failed: 0 },
      usd: 0,
      returns: 0,
      merged: 0,
      closed: 0,
      medianToMergeMs: null,
      stalls: { 'server-blocked': 0, 'host-paused': 0 },
      stalledMs: 0,
    });
  }
  return days;
}

/** Time from a run's done to the last of its merges. Null for a run that was not merged, or whose done time is unknown. */
function toMergeMs(run: StatsRunRow): number | null {
  const outcome = readOutcome(run.mergeOutcome);
  const doneAt = Date.parse(run.doneAt ?? '');
  if (!outcome || !('merged' in outcome) || !Number.isFinite(doneAt)) {
    return null;
  }
  const at = Math.max(...Object.values(outcome.merged).map((fact) => Date.parse(fact.at)));
  return Number.isFinite(at) ? Math.max(0, at - doneAt) : null;
}

function newestFirst(a: StatsRun, b: StatsRun): number {
  return b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key);
}

/** The statistics of the runs in `rows`. `durations` is the working time of each run by id. */
export function buildStats(
  rows: StatsRows,
  durations: Map<number, number>,
  now: number,
  range: StatsRange,
  requirements: Map<number, string> = new Map(),
  mergedDocuments: { runId: number; kind: string; body: string }[] = [],
): StatsView {
  const to = localDay(now, range.tzOffset);
  const firstDay = rows.firstRunAt === null ? to : [localDay(rows.firstRunAt, range.tzOffset), to].sort()[0];
  const from = range.days > 0 ? [shiftDay(to, 1 - range.days), firstDay].sort()[1] : firstDay;
  const days = emptyDays(from, to);
  const spend = spendOf(rows.steps, days, range.tzOffset, new Map(rows.runs.map((run) => [run.id, run.runtime])));
  const returns = returnsOf(rows.loops, days, range.tzOffset);
  stallsOf(rows.stalls, days, range.tzOffset);

  const agents = new Map<string, StatsShare>();
  const buckets = RETURN_BUCKETS.map(() => 0);
  const counts = { done: 0, active: 0, failed: 0 };
  const doneDurations: number[] = [];
  const toMerge: number[] = [];
  const toMergeByDay = new Map<string, number[]>();
  const ended = { merged: 0, closed: 0 };
  const mergedIds: number[] = [];
  let caughtAndFixed = 0;
  let firstPass = 0;
  for (const run of rows.runs) {
    const used = new Map([[run.runtime, { usd: 0, tokens: 0 }], ...(spend.byAgent.get(run.id) ?? [])]);
    for (const [runtime, agent] of used) {
      share(agents, runtime, agent.usd, agent.tokens);
    }
  }
  const counted = countedRunsOf(rows.runs);
  /** A run as the table shows it: its own figures, and its subtasks' when it has any. */
  const rowOf = (run: StatsRunRow, ids: number[]): StatsRun => ({
    key: run.key,
    name: runName(run.key, run.prompt),
    title: viewTitle(run, requirements.get(run.id) ?? null),
    status: run.status,
    outcome: outcomeOf(run.status),
    kind: ids.length > 1 ? 'epic' : 'task',
    usd: round(sumOver(ids, (id) => spend.byRun.get(id)?.usd ?? 0)),
    returns: sumOver(ids, (id) => returns.byRun.get(id) ?? 0),
    shellEdits: sumOver(ids, (id) => spend.shellEdits.get(id) ?? 0),
    durationMs: sumOver(ids, (id) => durations.get(id) ?? 0),
    createdAt: run.createdAt,
  });
  const runs: StatsRun[] = counted.map(({ run, ids }) => {
    const row = rowOf(run, ids);
    const { outcome, returns: backs, durationMs } = row;
    counts[outcome] += 1;
    if (run.state === 'merged') {
      mergedIds.push(run.id);
      caughtAndFixed += backs;
    }
    buckets[Math.min(backs, RETURN_BUCKETS.length - 1)] += 1;
    if (outcome === 'done' && backs === 0) {
      firstPass += 1;
    }
    if (outcome === 'done' && durationMs > 0) {
      doneDurations.push(durationMs);
    }
    const day = days.get(localDay(run.createdAt, range.tzOffset));
    if (day) {
      day[outcome] += 1;
    }
    if (outcome === 'done' && (run.state === 'merged' || run.state === 'closed')) {
      ended[run.state] += 1;
      if (day) {
        day[run.state] += 1;
      }
      const ms = toMergeMs(run);
      if (ms !== null) {
        toMerge.push(ms);
        if (day) {
          toMergeByDay.set(day.day, [...(toMergeByDay.get(day.day) ?? []), ms]);
        }
      }
    }
    return row;
  });

  const requirementsSum = requirementsOf(mergedIds, mergedDocuments);
  const units = unitsOf(rows.runs, {
    usdOf: (id) => spend.byRun.get(id)?.usd ?? 0,
    returnsOf: (id) => returns.byRun.get(id) ?? 0,
    workMsOf: (id) => durations.get(id) ?? 0,
    days,
    tzOffset: range.tzOffset,
  });
  return {
    from,
    to,
    epics: units.epics,
    tasks: units.tasks,
    totals: {
      runs: counted.length,
      ...counts,
      usd: round(spend.totals.usd),
      tokensIn: spend.totals.tokensIn,
      tokensOut: spend.totals.tokensOut,
      reviewReturns: returns.review,
      pipelineReturns: returns.pipeline,
      returnsByKind: returns.kinds,
      firstPass,
      limits: rows.steps.filter(limited).length,
      agentMs: spend.totals.agentMs,
      medianDoneMs: median(doneDurations),
      ...ended,
      medianToMergeMs: median(toMerge),
      requirementsMet: requirementsSum.met,
      requirementsTotal: requirementsSum.total,
      caughtAndFixed,
      personMessages: personMessagesOf(rows, rangeStart(now, range)),
    },
    days: [...days.values()].map((day) => ({
      ...day,
      usd: round(day.usd),
      medianToMergeMs: median(toMergeByDay.get(day.day) ?? []),
    })),
    steps: spend.steps,
    models: spend.models,
    efforts: spend.efforts,
    agents: [...agents.values()]
      .map((entry) => ({ ...entry, usd: round(entry.usd) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    reasons: returns.reasons,
    ciReturns: returns.ci,
    returnsPerRun: RETURN_BUCKETS.map((bucket, index) => ({ returns: bucket, runs: buckets[index] })),
    runs: runs.sort(newestFirst),
    subtasks: subtaskTasksOf(rows.runs)
      .map((run) => rowOf(run, [run.id]))
      .sort(newestFirst),
  };
}

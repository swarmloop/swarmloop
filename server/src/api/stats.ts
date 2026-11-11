import type { RunOutcome, StatsDay, StatsRun, StatsShare, StatsView } from '../contract/api';
import type { StatsRows, StatsRunRow, StatsStepRow } from '../history/stats.repository';
import { LIMIT_VISIT } from '../history/visit.repository';
import { readOutcome } from '../history/run-state';
import { runName } from './run-view/flow';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const RETURN_BUCKETS = ['0', '1', '2', '3', '4+'];

/** The last `days` local days, or every day when `days` is 0. Either way the days start no earlier than the first run. */
export interface StatsRange {
  days: number;
  /** Minutes the viewer's clock is behind UTC, as `Date.getTimezoneOffset` gives them (Warsaw in winter: -60). */
  tzOffset: number;
}

/** The local day of an ISO time, `YYYY-MM-DD`. */
export function localDay(iso: string | number, tzOffset: number): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Date(ms - tzOffset * MINUTE_MS).toISOString().slice(0, 10);
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

export function outcomeOf(status: string): RunOutcome {
  if (status === 'done') {
    return 'done';
  }
  return status === 'failed' || status === 'blocked' ? 'failed' : 'active';
}

/** Steps that ran an agent. The others (branch, commit, pipeline watch) spend nothing. */
function agentStep(step: StatsStepRow): boolean {
  return step.model !== null || step.tokensIn > 0 || step.usd > 0;
}

/** A launch that ended on a provider limit. Its spend counts under the agent that hit it; it counts as `limit`, not as a visit. */
function limited(step: StatsStepRow): boolean {
  return step.status === LIMIT_VISIT.status && step.killReason === LIMIT_VISIT.killReason;
}

function share(rows: Map<string, StatsShare>, name: string, usd: number, tokens: number, count = 1): void {
  const entry = rows.get(name) ?? { name, usd: 0, tokens: 0, count: 0 };
  entry.usd += usd;
  entry.tokens += tokens;
  entry.count += count;
  rows.set(name, entry);
}

function sortedShares(rows: Map<string, StatsShare>): StatsShare[] {
  return [...rows.values()]
    .filter((entry) => entry.usd > 0 || entry.tokens > 0)
    .map((entry) => ({ ...entry, usd: round(entry.usd) }))
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.name.localeCompare(b.name));
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function emptyDays(from: string, to: string): Map<string, StatsDay> {
  const days = new Map<string, StatsDay>();
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    days.set(day, {
      day,
      done: 0,
      active: 0,
      failed: 0,
      usd: 0,
      returns: 0,
      merged: 0,
      closed: 0,
      medianToMergeMs: null,
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

/**
 * Spend and tokens: in all, by run, by step, by model and by agent, and dollars on the day each step finished.
 * A step that recorded no runtime ran on the runtime of its run.
 */
function spendOf(steps: StatsStepRow[], days: Map<string, StatsDay>, tzOffset: number, runtimes: Map<number, string>) {
  const totals = { usd: 0, tokensIn: 0, tokensOut: 0, agentMs: 0 };
  const byRun = new Map<number, { usd: number; tokens: number }>();
  const byAgent = new Map<number, Map<string, { usd: number; tokens: number }>>();
  const bySteps = new Map<string, StatsShare>();
  const byModels = new Map<string, StatsShare>();
  for (const step of steps) {
    const tokens = step.tokensIn + step.tokensOut;
    totals.usd += step.usd;
    totals.tokensIn += step.tokensIn;
    totals.tokensOut += step.tokensOut;
    const run = byRun.get(step.runId) ?? { usd: 0, tokens: 0 };
    byRun.set(step.runId, { usd: run.usd + step.usd, tokens: run.tokens + tokens });
    const runtime = step.runtime ?? runtimes.get(step.runId);
    if (runtime !== undefined) {
      const agents = byAgent.get(step.runId) ?? new Map<string, { usd: number; tokens: number }>();
      const agent = agents.get(runtime) ?? { usd: 0, tokens: 0 };
      agents.set(runtime, { usd: agent.usd + step.usd, tokens: agent.tokens + tokens });
      byAgent.set(step.runId, agents);
    }
    if (agentStep(step)) {
      totals.agentMs += step.durationMs;
      share(bySteps, step.step, step.usd, tokens, limited(step) ? 0 : 1);
    }
    if (step.model) {
      share(byModels, step.model, step.usd, tokens, limited(step) ? 0 : 1);
    }
    const day = days.get(localDay(step.finishedAt, tzOffset));
    if (day) {
      day.usd += step.usd;
    }
  }
  return { totals, byRun, byAgent, steps: sortedShares(bySteps), models: sortedShares(byModels) };
}

/** Returns: by run, by reviewer (CI as `pipeline`), and on the day each happened. */
function returnsOf(loops: StatsRows['loops'], days: Map<string, StatsDay>, tzOffset: number) {
  const byRun = new Map<number, number>();
  const reasons = new Map<string, number>();
  let review = 0;
  let pipeline = 0;
  const count = (name: string): void => {
    reasons.set(name, (reasons.get(name) ?? 0) + 1);
  };
  for (const loop of loops) {
    byRun.set(loop.runId, (byRun.get(loop.runId) ?? 0) + 1);
    const day = days.get(localDay(loop.createdAt, tzOffset));
    if (day) {
      day.returns += 1;
    }
    if (loop.counter === 'pipeline') {
      pipeline += 1;
      count('pipeline');
      continue;
    }
    review += 1;
    const reviewers = loop.reason
      .split(',')
      .map((name) => name.trim().replace(/^review_/, ''))
      .filter((name) => name !== '');
    (reviewers.length > 0 ? reviewers : ['review']).forEach(count);
  }
  const ranked = [...reasons.entries()]
    .map(([name, returns]) => ({ name, returns }))
    .sort((a, b) => b.returns - a.returns || a.name.localeCompare(b.name));
  return { byRun, review, pipeline, reasons: ranked };
}

/** The statistics of the runs in `rows`. `durations` is the working time of each run by id. */
export function buildStats(rows: StatsRows, durations: Map<number, number>, now: number, range: StatsRange): StatsView {
  const to = localDay(now, range.tzOffset);
  const firstDay = rows.firstRunAt === null ? to : [localDay(rows.firstRunAt, range.tzOffset), to].sort()[0];
  const from = range.days > 0 ? [shiftDay(to, 1 - range.days), firstDay].sort()[1] : firstDay;
  const days = emptyDays(from, to);
  const spend = spendOf(rows.steps, days, range.tzOffset, new Map(rows.runs.map((run) => [run.id, run.runtime])));
  const returns = returnsOf(rows.loops, days, range.tzOffset);

  const agents = new Map<string, StatsShare>();
  const buckets = RETURN_BUCKETS.map(() => 0);
  const counts = { done: 0, active: 0, failed: 0 };
  const doneDurations: number[] = [];
  const toMerge: number[] = [];
  const toMergeByDay = new Map<string, number[]>();
  const ended = { merged: 0, closed: 0 };
  let firstPass = 0;
  const runs: StatsRun[] = rows.runs.map((run) => {
    const outcome = outcomeOf(run.status);
    const backs = returns.byRun.get(run.id) ?? 0;
    const spent = spend.byRun.get(run.id) ?? { usd: 0, tokens: 0 };
    const durationMs = durations.get(run.id) ?? 0;
    counts[outcome] += 1;
    buckets[Math.min(backs, RETURN_BUCKETS.length - 1)] += 1;
    if (outcome === 'done' && backs === 0) {
      firstPass += 1;
    }
    if (outcome === 'done' && durationMs > 0) {
      doneDurations.push(durationMs);
    }
    const used = new Map([[run.runtime, { usd: 0, tokens: 0 }], ...(spend.byAgent.get(run.id) ?? [])]);
    for (const [runtime, agent] of used) {
      share(agents, runtime, agent.usd, agent.tokens);
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
    const name = runName(run.key, run.prompt);
    return {
      key: run.key,
      name,
      status: run.status,
      outcome,
      usd: round(spent.usd),
      returns: backs,
      durationMs,
      createdAt: run.createdAt,
    };
  });

  return {
    from,
    to,
    totals: {
      runs: rows.runs.length,
      ...counts,
      usd: round(spend.totals.usd),
      tokensIn: spend.totals.tokensIn,
      tokensOut: spend.totals.tokensOut,
      reviewReturns: returns.review,
      pipelineReturns: returns.pipeline,
      firstPass,
      limits: rows.steps.filter(limited).length,
      agentMs: spend.totals.agentMs,
      medianDoneMs: median(doneDurations),
      ...ended,
      medianToMergeMs: median(toMerge),
    },
    days: [...days.values()].map((day) => ({
      ...day,
      usd: round(day.usd),
      medianToMergeMs: median(toMergeByDay.get(day.day) ?? []),
    })),
    steps: spend.steps,
    models: spend.models,
    agents: [...agents.values()]
      .map((entry) => ({ ...entry, usd: round(entry.usd) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    reasons: returns.reasons,
    returnsPerRun: RETURN_BUCKETS.map((bucket, index) => ({ returns: bucket, runs: buckets[index] })),
    runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key)),
  };
}

import type { StatsCiReturns, StatsDay, StatsReason } from '../contract/api';
import type { StatsRows } from '../history/stats.repository';
import { NON_RETURN_COUNTERS, readLoopDetail, reviewersOf } from '../history/loop-detail';
import { localDay } from './local-day';

/** What sent the work back: the loop counter. Returns of the checks step before it had its own counter were recorded under implement. */
function kindOf(loop: StatsRows['loops'][number]): string {
  return loop.counter === 'implement' && loop.reason === 'required checks failed' ? 'checks' : loop.counter;
}

function ranked(counts: Map<string, number>): { name: string; returns: number }[] {
  return [...counts.entries()]
    .map(([name, returns]) => ({ name, returns }))
    .sort((a, b) => b.returns - a.returns || a.name.localeCompare(b.name));
}

interface Returns {
  byRun: Map<number, number>;
  review: number;
  pipeline: number;
  kinds: { kind: string; returns: number }[];
  reasons: StatsReason[];
  ci: StatsCiReturns;
}

/** Returns: by run, by kind, by reason (one reviewer per entry), the CI ones by whether the checks had passed, and on the day each happened. */
export function returnsOf(loops: StatsRows['loops'], days: Map<string, StatsDay>, tzOffset: number): Returns {
  const byRun = new Map<number, number>();
  const kinds = new Map<string, number>();
  const reasons = new Map<string, number>();
  const commands = new Map<string, number>();
  const ciJobs = new Map<string, number>();
  const ci: StatsCiReturns = { only: 0, withChecks: 0, jobs: [] };
  const count = (counts: Map<string, number>, name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const loop of loops.filter(({ counter }) => !NON_RETURN_COUNTERS.includes(counter))) {
    byRun.set(loop.runId, (byRun.get(loop.runId) ?? 0) + 1);
    const day = days.get(localDay(loop.createdAt, tzOffset));
    if (day) {
      day.returns += 1;
    }
    const kind = kindOf(loop);
    const detail = readLoopDetail(loop.detail);
    count(kinds, kind);
    if (kind === 'review') {
      const reviewers = reviewersOf(loop.reason);
      (reviewers.length > 0 ? reviewers : ['review']).forEach((name) => count(reasons, name));
      continue;
    }
    count(reasons, kind);
    (kind === 'checks' ? (detail.commands ?? []) : []).forEach((name) => count(commands, name));
    if (kind === 'pipeline') {
      if (detail.ciOnly) {
        ci.only += 1;
        (detail.jobs ?? []).forEach((name) => count(ciJobs, name));
      } else {
        ci.withChecks += 1;
      }
    }
  }
  const bars: StatsReason[] = ranked(reasons).map((reason) =>
    reason.name === 'checks' && commands.size > 0 ? { ...reason, commands: ranked(commands) } : reason,
  );
  return {
    byRun,
    review: kinds.get('review') ?? 0,
    pipeline: kinds.get('pipeline') ?? 0,
    kinds: ranked(kinds).map(({ name, returns }) => ({ kind: name, returns })),
    reasons: bars,
    ci: { ...ci, jobs: ranked(ciJobs) },
  };
}

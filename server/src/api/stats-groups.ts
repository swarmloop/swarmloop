import type { StatsShare } from '../contract/api';
import type { StatsStepRow } from '../history/stats.repository';
import { LIMIT_VISIT } from '../history/visit.repository';

/** Steps that ran an agent. The others (branch, commit, pipeline watch) spend nothing. */
export function agentStep(step: StatsStepRow): boolean {
  return step.model !== null || step.tokensIn > 0 || step.usd > 0;
}

/** A launch that ended on a provider limit. Its spend counts under the agent that hit it; it counts as `limit`, not as a visit. */
export function limited(step: StatsStepRow): boolean {
  return step.status === LIMIT_VISIT.status && step.killReason === LIMIT_VISIT.killReason;
}

export function share(rows: Map<string, StatsShare>, name: string, usd: number, tokens: number, count = 1): void {
  const entry = rows.get(name) ?? { name, usd: 0, tokens: 0, count: 0 };
  entry.usd += usd;
  entry.tokens += tokens;
  entry.count += count;
  rows.set(name, entry);
}

export function sortedShares(rows: Map<string, StatsShare>): StatsShare[] {
  return [...rows.values()]
    .filter((entry) => entry.usd > 0 || entry.tokens > 0)
    .map((entry) => ({ ...entry, usd: round(entry.usd) }))
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.name.localeCompare(b.name));
}

export function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

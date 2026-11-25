import type { StatsDay, StatsShare } from '../contract/api';
import type { StatsStepRow } from '../history/stats.repository';
import { agentStep, limited, RUNTIME_DEFAULT, share, sortedShares } from './stats-groups';
import { localDay } from './local-day';

interface Spend {
  totals: { usd: number; tokensIn: number; tokensOut: number; agentMs: number };
  byRun: Map<number, { usd: number; tokens: number }>;
  shellEdits: Map<number, number>;
  byAgent: Map<number, Map<string, { usd: number; tokens: number }>>;
  steps: StatsShare[];
  models: StatsShare[];
  efforts: StatsShare[];
}

/**
 * Spend and tokens: in all, by run, by step, by model and by agent, and dollars on the day each step finished.
 * A step that recorded no runtime ran on the runtime of its run.
 */
export function spendOf(
  steps: StatsStepRow[],
  days: Map<string, StatsDay>,
  tzOffset: number,
  runtimes: Map<number, string>,
): Spend {
  const totals = { usd: 0, tokensIn: 0, tokensOut: 0, agentMs: 0 };
  const byRun = new Map<number, { usd: number; tokens: number }>();
  const shellEdits = new Map<number, number>();
  const byAgent = new Map<number, Map<string, { usd: number; tokens: number }>>();
  const bySteps = new Map<string, StatsShare>();
  const byModels = new Map<string, StatsShare>();
  const byEfforts = new Map<string, StatsShare>();
  for (const step of steps) {
    const tokens = step.tokensIn + step.tokensOut;
    totals.usd += step.usd;
    totals.tokensIn += step.tokensIn;
    totals.tokensOut += step.tokensOut;
    shellEdits.set(step.runId, (shellEdits.get(step.runId) ?? 0) + step.shellEdits);
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
      share(byEfforts, step.effort ?? RUNTIME_DEFAULT, step.usd, tokens, limited(step) ? 0 : 1);
    }
    if (step.model) {
      share(byModels, step.model, step.usd, tokens, limited(step) ? 0 : 1);
    }
    const day = days.get(localDay(step.finishedAt, tzOffset));
    if (day) {
      day.usd += step.usd;
    }
  }
  return {
    totals,
    byRun,
    shellEdits,
    byAgent,
    steps: sortedShares(bySteps),
    models: sortedShares(byModels),
    efforts: sortedShares(byEfforts),
  };
}

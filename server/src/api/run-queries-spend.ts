import type { LiveUsage } from '../contract/live';
import type { RunEntity } from '../history/entities';
import type { LiveHub } from '../live/live.hub';
import type { PipelineService } from '../pipeline/pipeline.service';

export function openSpend(run: RunEntity, pipeline: PipelineService, live?: LiveHub): LiveUsage {
  const running = run.status === 'running' || pipeline.claimed(run.key);
  if (!running) {
    return { tokensIn: 0, tokensOut: 0, usd: 0 };
  }
  return live?.spendOf(run.key) ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
}

/** What a run has cost: the stored spend and what its open visits have used so far. */
export function spentUsd(run: RunEntity, pipeline: PipelineService, live?: LiveHub): number {
  return run.spentUsd + openSpend(run, pipeline, live).usd;
}

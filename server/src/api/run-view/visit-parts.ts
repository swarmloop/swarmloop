import type { VisitView } from '../../contract/api';
import type { AgentExchangeEntity, ResourceSampleEntity } from '../../history/entities';

/** The agent exchanges of one stored visit. */
export function exchangesOf(exchanges: AgentExchangeEntity[], statId: number): VisitView['exchanges'] {
  return exchanges
    .filter((exchange) => exchange.stepStatId === statId)
    .map((exchange) => ({
      model: exchange.model,
      durationMs: exchange.durationMs,
      request: exchange.requestText,
      response: exchange.responseText,
    }));
}

/** The resource samples of one stored visit. */
export function samplesOf(samples: ResourceSampleEntity[], statId: number): VisitView['samples'] {
  return samples
    .filter((sample) => sample.stepStatId === statId)
    .map((sample) => ({ at: sample.sampledAt, cpu: sample.cpuPercent, memory: sample.rssBytes }));
}

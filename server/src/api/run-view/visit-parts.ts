import { decisionLine } from './chips';
import { latest } from './status';
import { REVIEW_KINDS } from './run-view.types';
import type { CheckCommandView, StepView, VisitView } from '../../contract/api';
import type {
  DocumentEntity,
  AgentExchangeEntity,
  CheckCommandEntity,
  ResourceSampleEntity,
} from '../../history/entities';

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
    .map((sample) => ({
      at: sample.sampledAt,
      cpu: sample.cpuPercent,
      memory: sample.rssBytes,
      source: sample.source ?? 'agent',
    }));
}

/** The commands of the checks visits of a run. */
export function commandViewsOf(rows: CheckCommandEntity[]): CheckCommandView[] {
  return rows.map((row) => ({
    attempt: row.attemptId,
    index: row.commandIndex,
    repo: row.repo,
    command: row.command,
    name: row.name,
    status: row.status as CheckCommandView['status'],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    exitCode: row.exitCode,
  }));
}

/** The commands of the latest checks attempt: the rows of the attempt of the newest row. */
export function latestCommandViews(rows: CheckCommandEntity[]): CheckCommandView[] {
  const newest = rows.reduce<CheckCommandEntity | undefined>(
    (last, row) => (!last || row.id > last.id ? row : last),
    undefined,
  );
  return commandViewsOf(rows.filter((row) => row.attemptId === newest?.attemptId));
}

/** The decision of each reviewer that wrote one. */
export function reviewChecks(documents: DocumentEntity[]): StepView['checks'] {
  return REVIEW_KINDS.map((kind) => {
    const body = latest(documents, kind);
    return { name: kind.replace('review_', ''), decision: decisionLine(body ?? ''), body: body ?? '' };
  }).filter((check) => check.body !== '');
}

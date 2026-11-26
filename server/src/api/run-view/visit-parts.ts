import { storedReview } from '../../agent-result/stored-review';
import { latest } from './status';
import { REVIEW_KINDS } from './run-view.types';
import type { CheckCommandView, StepView, VisitView } from '../../contract/api';
import { isEffort } from '../../contract/effort';
import type {
  DocumentEntity,
  StepStatEntity,
  AgentExchangeEntity,
  CheckCommandEntity,
  ResourceSampleEntity,
} from '../../history/entities';

/** What the log keeps that is not an exchange of the chat: a helper's call, a keep-warm ping and the mark where pings stopped. */
const NOT_EXCHANGES = new Set(['helper', 'ping', 'ping-stop']);

/**
 * The agent exchanges of one stored visit: one per launch. A launch is its first call and the follow-ups after it,
 * each linked to the call before by `previousId`; it shows the first call's request and the last call's response.
 * A row with no request text (the cost row the log's migration made for an old visit that had no exchange) is no exchange.
 */
export function exchangesOf(rows: AgentExchangeEntity[], statId: number): VisitView['exchanges'] {
  const launches: VisitView['exchanges'] = [];
  const byLastCall = new Map<number, VisitView['exchanges'][number]>();
  for (const row of rows) {
    if (row.stepStatId !== statId || NOT_EXCHANGES.has(row.kind) || row.requestText === '') {
      continue;
    }
    const launch =
      row.startReason === 'follow-up' && row.previousId !== null ? byLastCall.get(row.previousId) : undefined;
    if (launch) {
      byLastCall.delete(row.previousId!);
      launch.response = row.responseText;
      launch.durationMs += row.durationMs;
      byLastCall.set(row.id, launch);
      continue;
    }
    const first = {
      model: row.model,
      durationMs: row.durationMs,
      request: row.requestText,
      response: row.responseText,
    };
    launches.push(first);
    byLastCall.set(row.id, first);
  }
  return launches;
}

/** The effort a stored visit ran with, left out when it ran at its runtime's default. */
export function effortOf(stat: StepStatEntity): Pick<VisitView, 'effort' | 'effortNote'> {
  if (!stat.effort || !isEffort(stat.effort)) {
    return {};
  }
  return { effort: stat.effort, ...(stat.effortNote ? { effortNote: stat.effortNote } : {}) };
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
    const name = kind.replace('review_', '');
    const decision = storedReview(name, documents)?.decision;
    return { name, decision: decision ? `decision: ${decision}` : null, body: body ?? '' };
  }).filter((check) => check.body !== '');
}

import type { EntityManager, Repository } from 'typeorm';
import { ERROR_CODES } from '../contract/error-codes';
import type { AgentCallRepository } from './agent-call.repository';
import { summarizeSamples } from './visit';
import type { VisitDraft } from './visit';
import { StepStatEntity, ResourceSampleEntity, HttpCallEntity, DocumentEntity } from './entities';
import type { RunEntity } from './entities';

export interface VisitTables {
  stepStats: Repository<StepStatEntity>;
  samples: Repository<ResourceSampleEntity>;
  httpCalls: Repository<HttpCallEntity>;
  documents: Repository<DocumentEntity>;
}

export function tablesOf(manager: EntityManager): VisitTables {
  return {
    stepStats: manager.getRepository(StepStatEntity),
    samples: manager.getRepository(ResourceSampleEntity),
    httpCalls: manager.getRepository(HttpCallEntity),
    documents: manager.getRepository(DocumentEntity),
  };
}

/** How a visit that ended on a provider limit is recorded. */
export const LIMIT_VISIT = { status: 'interrupted', killReason: ERROR_CODES.RUNTIME_LIMIT } as const;

export async function insertVisit(
  { stepStats, samples, httpCalls, documents }: VisitTables,
  calls: AgentCallRepository,
  run: RunEntity,
  visit: VisitDraft,
  attemptId: string | null,
): Promise<StepStatEntity> {
  // A launch that ended on a provider limit is no attempt: the visit after it keeps the number.
  const previous =
    (await stepStats.count({ where: { runId: run.id, step: visit.step } })) -
    (await stepStats.count({ where: { runId: run.id, step: visit.step, ...LIMIT_VISIT } }));
  const stats = summarizeSamples(visit.samples);
  const now = visit.finishedAt;
  const stat = await stepStats.save(
    stepStats.create({
      runId: run.id,
      step: visit.step,
      attempt: previous + 1,
      runtime: visit.runtime ?? null,
      model: visit.model,
      effort: visit.effort ?? null,
      effortNote: visit.effortNote ?? null,
      mode: visit.mode,
      startedAt: visit.startedAt,
      stepStartedAt: run.stepStartedAt,
      finishedAt: visit.finishedAt,
      durationMs: visit.durationMs,
      status: visit.status,
      exitCode: visit.exitCode,
      killReason: visit.killReason,
      tokensIn: visit.tokensIn,
      tokensOut: visit.tokensOut,
      usd: visit.usd,
      cpuAvg: stats.cpuAvg,
      cpuPeak: stats.cpuPeak,
      memAvg: stats.memAvg,
      memPeak: stats.memPeak,
      resumed: visit.resumed ? 1 : 0,
      preparedMs: visit.preparedMs ?? null,
      shellEdits: visit.shellEdits ?? 0,
      checkedCommits: visit.checkedCommits ? JSON.stringify(visit.checkedCommits) : null,
      attemptId,
    }),
  );
  for (const sample of visit.samples) {
    await samples.save(
      samples.create({
        stepStatId: stat.id,
        sampledAt: sample.sampledAt,
        cpuPercent: sample.cpuPercent,
        rssBytes: sample.rssBytes,
        source: sample.source,
      }),
    );
  }
  await calls.linkVisit(visit.callIds ?? [], stat.id);
  for (const call of visit.httpCalls) {
    await httpCalls.save(
      httpCalls.create({
        runId: run.id,
        stepStatId: stat.id,
        provider: call.provider,
        method: call.method,
        url: call.url,
        statusCode: call.statusCode,
        durationMs: call.durationMs,
        error: call.error,
        createdAt: now,
      }),
    );
  }
  for (const document of visit.documents ?? (visit.document ? [visit.document] : [])) {
    const latest = await documents.findOne({
      where: { runId: run.id, kind: document.kind },
      order: { id: 'DESC' },
    });
    if (document.perVisit || latest?.body !== document.body) {
      await documents.save(
        documents.create({
          runId: run.id,
          stepStatId: stat.id,
          kind: document.kind,
          attempt: stat.attempt,
          body: document.body,
          path: '',
          createdAt: now,
        }),
      );
    }
  }
  return stat;
}

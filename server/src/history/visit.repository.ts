import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { ERROR_CODES } from '../contract/error-codes';
import { releasedColumns } from './run-state';
import { transaction } from './transaction';
import { summarizeSamples } from './visit';
import type { VisitDraft } from './visit';
import {
  StepStatEntity,
  ResourceSampleEntity,
  AgentExchangeEntity,
  HttpCallEntity,
  DocumentEntity,
  RunEntity,
} from './entities';

interface VisitTables {
  stepStats: Repository<StepStatEntity>;
  samples: Repository<ResourceSampleEntity>;
  exchanges: Repository<AgentExchangeEntity>;
  httpCalls: Repository<HttpCallEntity>;
  documents: Repository<DocumentEntity>;
}

function tablesOf(manager: EntityManager): VisitTables {
  return {
    stepStats: manager.getRepository(StepStatEntity),
    samples: manager.getRepository(ResourceSampleEntity),
    exchanges: manager.getRepository(AgentExchangeEntity),
    httpCalls: manager.getRepository(HttpCallEntity),
    documents: manager.getRepository(DocumentEntity),
  };
}

/** How a visit that ended on a provider limit is recorded. */
export const LIMIT_VISIT = { status: 'interrupted', killReason: ERROR_CODES.RUNTIME_LIMIT } as const;

const DUPLICATE_ATTEMPT = 'UNIQUE constraint failed: step_stats.attempt_id';

@Injectable()
export class VisitRepository {
  private readonly logger = new Logger(VisitRepository.name);

  constructor(
    @InjectRepository(StepStatEntity) private readonly stepStats: Repository<StepStatEntity>,
    @InjectRepository(ResourceSampleEntity) private readonly samples: Repository<ResourceSampleEntity>,
    @InjectRepository(AgentExchangeEntity) private readonly exchanges: Repository<AgentExchangeEntity>,
    @InjectRepository(HttpCallEntity) private readonly httpCalls: Repository<HttpCallEntity>,
    @InjectRepository(DocumentEntity) private readonly documents: Repository<DocumentEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async finishVisit(run: RunEntity, visit: VisitDraft): Promise<StepStatEntity> {
    return this.insertVisit(this.tables, run, visit, null);
  }

  /**
   * Stores the visit and moves the run on in one transaction, if `attemptId` is still the run's active attempt.
   * A repeat of an attempt returns its stored visit. A stale attempt stores nothing and returns null.
   * Either way `run` ends up as the row in the database.
   */
  async finalize(attemptId: string | null, run: RunEntity, visit: VisitDraft): Promise<StepStatEntity | null> {
    const stat = await transaction(this.dataSource, async (manager) => {
      const stored = attemptId ? await manager.getRepository(StepStatEntity).findOneBy({ attemptId }) : null;
      if (stored) {
        return stored;
      }
      const { id, ...fields } = run;
      const moved = await manager
        .getRepository(RunEntity)
        .createQueryBuilder()
        .update()
        .set({
          ...fields,
          ...releasedColumns(),
          stepStartedAt: null,
          updatedAt: visit.finishedAt,
          revision: () => 'revision + 1',
        })
        .where('id = :id AND active_attempt IS :attemptId', { id, attemptId })
        .execute();
      return moved.affected ? this.insertVisit(tablesOf(manager), run, visit, attemptId) : null;
    }).catch(async (error: unknown) => {
      if (attemptId && String(error).includes(DUPLICATE_ATTEMPT)) {
        return this.stepStats.findOneBy({ attemptId });
      }
      throw error;
    });
    if (!stat) {
      this.logger.warn(`stale attempt ${attemptId} of ${run.key}`);
    }
    Object.assign(run, await this.dataSource.getRepository(RunEntity).findOneByOrFail({ id: run.id }));
    return stat;
  }

  private async insertVisit(
    { stepStats, samples, exchanges, httpCalls, documents }: VisitTables,
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
    for (const exchange of visit.exchanges ?? (visit.exchange ? [visit.exchange] : [])) {
      await exchanges.save(
        exchanges.create({
          stepStatId: stat.id,
          model: exchange.model,
          startedAt: exchange.startedAt,
          finishedAt: exchange.finishedAt,
          durationMs: exchange.durationMs,
          requestText: exchange.requestText,
          responseText: exchange.responseText,
          chatId: exchange.chatId,
          resumed: exchange.resumed ? 1 : 0,
          killReason: exchange.killReason,
        }),
      );
    }
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

  private get tables(): VisitTables {
    return {
      stepStats: this.stepStats,
      samples: this.samples,
      exchanges: this.exchanges,
      httpCalls: this.httpCalls,
      documents: this.documents,
    };
  }

  async saveStat(stat: StepStatEntity): Promise<void> {
    await this.stepStats.save(stat);
  }

  /** The content each project was checked at by the newest checks visit; null when there is none or it did not pass. */
  async latestChecked(runId: number): Promise<Record<string, string> | null> {
    const stat = await this.stepStats.findOne({ where: { runId, step: 'checks' }, order: { id: 'DESC' } });
    return stat?.checkedCommits ? (JSON.parse(stat.checkedCommits) as Record<string, string>) : null;
  }

  async listStats(runId: number): Promise<StepStatEntity[]> {
    return this.stepStats.find({ where: { runId }, order: { id: 'ASC' } });
  }

  /** Whether an agent ran in a finished (done or waiting) visit of this step: a visit with a stored exchange. */
  async hasAgentVisit(runId: number, step: string): Promise<boolean> {
    const stats = await this.stepStats.find({ where: { runId, step, status: In(['done', 'waiting']) } });
    if (stats.length === 0) {
      return false;
    }
    return (await this.exchanges.count({ where: { stepStatId: In(stats.map((stat) => stat.id)) } })) > 0;
  }

  async listSamples(statIds: number[]): Promise<ResourceSampleEntity[]> {
    if (statIds.length === 0) {
      return [];
    }
    return this.samples.find({ where: { stepStatId: In(statIds) }, order: { id: 'ASC' } });
  }

  async listExchanges(statIds: number[]): Promise<AgentExchangeEntity[]> {
    if (statIds.length === 0) {
      return [];
    }
    return this.exchanges.find({ where: { stepStatId: In(statIds) }, order: { id: 'ASC' } });
  }

  async codeReviewReportMs(runId?: number): Promise<Map<number, number>> {
    const rows: { stepStatId: number | string; durationMs: number | string | null }[] = await this.exchanges.query(
      `SELECT e.step_stat_id AS stepStatId, SUM(e.duration_ms) AS durationMs
       FROM agent_exchanges e
       INNER JOIN step_stats s ON s.id = e.step_stat_id
       WHERE s.step = 'code-review'${runId === undefined ? '' : ' AND s.run_id = ?'}
       GROUP BY e.step_stat_id`,
      runId === undefined ? [] : [runId],
    );
    const totals = new Map<number, number>();
    for (const row of rows) {
      totals.set(Number(row.stepStatId), Number(row.durationMs) || 0);
    }
    return totals;
  }

  async latestChatId(runId: number): Promise<string | null> {
    const stats = await this.stepStats.find({ where: { runId }, order: { id: 'DESC' } });
    for (const stat of stats) {
      const exchange = await this.exchanges.findOne({ where: { stepStatId: stat.id }, order: { id: 'DESC' } });
      if (exchange?.chatId) {
        return exchange.chatId;
      }
    }
    return null;
  }

  async tokenTotal(runId: number): Promise<number> {
    const rows: { total: number | string | null }[] = await this.stepStats.query(
      'SELECT SUM(tokens_in + tokens_out) AS total FROM step_stats WHERE run_id = ?',
      [runId],
    );
    return Number(rows[0]?.total) || 0;
  }
}

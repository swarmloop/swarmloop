import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { CommandType } from '../contract/command';
import type { InterruptionNote } from '../contract/interruption';
import { LiveHub } from '../live/live.hub';
import { insertAcceptedCommand } from './accepted-command';
import { AgentCallRepository } from './agent-call.repository';
import { adoptRow, changedColumns } from './run-read';
import { RunOpenItems } from './run-open-items';
import { releasedColumns } from './run-state';
import { transaction } from './transaction';
import type { VisitDraft } from './visit';
import { insertVisit, tablesOf } from './visit-insert';
import type { VisitTables } from './visit-insert';
import {
  StepStatEntity,
  ResourceSampleEntity,
  AgentExchangeEntity,
  HttpCallEntity,
  DocumentEntity,
  RunEntity,
} from './entities';

export { LIMIT_VISIT } from './visit-insert';

/** A command that is accepted in the transaction that stores the visit. */
interface FinalizeCommand {
  type: CommandType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  now: string;
}

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
    private readonly calls: AgentCallRepository,
    private readonly openItems: RunOpenItems,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async finishVisit(run: RunEntity, visit: VisitDraft): Promise<StepStatEntity> {
    const stat = await insertVisit(this.tables, this.calls, run, visit, null);
    this.live?.changed(run.key);
    return stat;
  }

  /**
   * Stores the visit and moves the run on in one transaction, if `attemptId` is still the run's active attempt.
   * A repeat of an attempt returns its stored visit. A stale attempt stores nothing and returns null.
   * Either way `run` ends up as the row in the database.
   */
  async finalize(
    attemptId: string | null,
    run: RunEntity,
    visit: VisitDraft,
    command?: FinalizeCommand,
  ): Promise<StepStatEntity | null> {
    const stat = await transaction(this.dataSource, async (manager) => {
      const stored = attemptId ? await manager.getRepository(StepStatEntity).findOneBy({ attemptId }) : null;
      if (stored) {
        return stored;
      }
      const { id } = run;
      const moved = await manager
        .getRepository(RunEntity)
        .createQueryBuilder()
        .update()
        .set({
          ...changedColumns(run),
          ...releasedColumns(),
          stepStartedAt: null,
          updatedAt: visit.finishedAt,
          revision: () => 'revision + 1',
        })
        .where('id = :id AND active_attempt IS :attemptId', { id, attemptId })
        .execute();
      if (!moved.affected) return null;
      if (command) {
        await insertAcceptedCommand(manager, {
          runId: id,
          type: command.type,
          payload: JSON.stringify(command.payload),
          idempotencyKey: command.idempotencyKey,
          now: command.now,
        });
      }
      const inserted = await insertVisit(tablesOf(manager), this.calls, run, visit, attemptId);
      await this.openItems.hold(manager, { id });
      return inserted;
    }).catch(async (error: unknown) => {
      if (attemptId && String(error).includes(DUPLICATE_ATTEMPT)) {
        return this.stepStats.findOneBy({ attemptId });
      }
      throw error;
    });
    if (!stat) {
      this.logger.warn(`stale attempt ${attemptId} of ${run.key}`);
    }
    adoptRow(run, await this.dataSource.getRepository(RunEntity).findOneByOrFail({ id: run.id }));
    this.live?.changed(run.key);
    return stat;
  }

  /**
   * The relaunch of a cut visit ended before its step took the run: `run`, as the caller changed it, is saved and the
   * interruption note of the visit is replaced, in one transaction. Nothing is written when the run moved since it
   * was read. Either way `run` ends up as the row in the database.
   */
  async endRelaunch(
    run: RunEntity,
    stat: Pick<StepStatEntity, 'id'>,
    note: InterruptionNote,
    at: string,
  ): Promise<boolean> {
    const ended = await transaction(this.dataSource, async (manager) => {
      const { id } = run;
      const moved = await manager
        .getRepository(RunEntity)
        .createQueryBuilder()
        .update()
        .set({ ...changedColumns(run), updatedAt: at, revision: () => 'revision + 1' })
        .where('id = :id AND revision = :revision', { id, revision: run.revision })
        .execute();
      if (!moved.affected) return false;
      await manager
        .getRepository(DocumentEntity)
        .update({ stepStatId: stat.id, kind: 'interruption' }, { body: JSON.stringify(note) });
      await this.openItems.hold(manager, { id });
      return true;
    });
    adoptRow(run, await this.dataSource.getRepository(RunEntity).findOneByOrFail({ id: run.id }));
    return ended;
  }

  private get tables(): VisitTables {
    return {
      stepStats: this.stepStats,
      samples: this.samples,
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

  /** When each step of each of the runs finished a visit, by run id, in one read whatever the number of runs. */
  async finishesOf(runIds: number[]): Promise<Map<number, Pick<StepStatEntity, 'step' | 'finishedAt'>[]>> {
    const found = runIds.length
      ? await this.stepStats.find({
          where: { runId: In(runIds) },
          select: { runId: true, step: true, finishedAt: true },
        })
      : [];
    const byRun = new Map<number, Pick<StepStatEntity, 'step' | 'finishedAt'>[]>();
    for (const { runId, step, finishedAt } of found)
      byRun.set(runId, [...(byRun.get(runId) ?? []), { step, finishedAt }]);
    return byRun;
  }

  /**
   * The latest visit of each of the runs, with only its id, kill reason, attempt and end time, in two reads whatever
   * the number of runs.
   */
  async latestVisits(
    runIds: number[],
  ): Promise<Map<number, Pick<StepStatEntity, 'id' | 'killReason' | 'attemptId' | 'finishedAt'>>> {
    if (runIds.length === 0) {
      return new Map();
    }
    const newest: { id: number }[] = await this.stepStats
      .createQueryBuilder('stat')
      .select('MAX(stat.id)', 'id')
      .where('stat.runId IN (:...runIds)', { runIds })
      .groupBy('stat.runId')
      .getRawMany();
    const found = await this.stepStats.find({
      where: { id: In(newest.map(({ id }) => Number(id))) },
      select: { id: true, runId: true, killReason: true, attemptId: true, finishedAt: true },
    });
    return new Map(found.map((stat) => [stat.runId, stat]));
  }

  /** Whether an agent ran in a finished (done or waiting) visit of this step: a visit with a stored exchange. */
  async hasAgentVisit(runId: number, step: string): Promise<boolean> {
    const stats = await this.stepStats.find({ where: { runId, step, status: In(['done', 'waiting']) } });
    return this.hasExchange(stats);
  }

  /** Like `hasAgentVisit`, for the visits the step made itself: a start from outside the step (a planner's turn) does not count. */
  async hasStepVisit(runId: number, step: string): Promise<boolean> {
    const stats = await this.stepStats
      .createQueryBuilder('stat')
      .where('stat.runId = :runId AND stat.step = :step AND stat.status IN (:...status)', {
        runId,
        step,
        status: ['done', 'waiting'],
      })
      .andWhere('stat.id NOT IN (SELECT stat_id FROM visit_starts WHERE outside = 1 AND stat_id IS NOT NULL)')
      .getMany();
    return this.hasExchange(stats);
  }

  private async hasExchange(stats: { id: number }[]): Promise<boolean> {
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

  /** The code-review exchange time of each visit: of the runs with these ids, or of every run when none is given. */
  async codeReviewReportMs(...runIds: number[]): Promise<Map<number, number>> {
    const rows: { stepStatId: number | string; durationMs: number | string | null }[] = await this.exchanges.query(
      `SELECT e.step_stat_id AS stepStatId, SUM(e.duration_ms) AS durationMs
       FROM agent_exchanges e
       INNER JOIN step_stats s ON s.id = e.step_stat_id
       WHERE s.step = 'code-review' AND e.kind <> 'helper'${runIds.length === 0 ? '' : ` AND s.run_id IN (${runIds.map(() => '?').join(', ')})`}
       GROUP BY e.step_stat_id`,
      runIds,
    );
    const totals = new Map<number, number>();
    for (const row of rows) {
      totals.set(Number(row.stepStatId), Number(row.durationMs) || 0);
    }
    return totals;
  }
}

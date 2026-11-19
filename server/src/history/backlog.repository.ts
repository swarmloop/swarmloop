import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { In } from 'typeorm';
import { Clock } from '../core/clock';
import type { BacklogEventKind, RunBacklog } from '../contract/backlog';
import type { SubtaskStatus } from '../contract/subtask';
import {
  BacklogEntity,
  BacklogEventEntity,
  BacklogTaskEntity,
  DecisionEntity,
  MilestoneEntity,
  RequirementEntity,
} from './backlog.entities';
import {
  toBacklog,
  toEvent,
  toMilestone,
  toRequirement,
  toTask,
  writersOn,
  type BacklogEventRecord,
  type BacklogMessageRecord,
  type BacklogRecord,
  type BacklogTaskRecord,
  type BacklogTurnRecord,
  type BacklogWriters,
  type DecisionRecord,
  type Facts,
  type MilestoneRecord,
  type RequirementRecord,
} from './backlog-writers';
import { transaction } from './transaction';

export type { BacklogTaskRecord };

const FINISHED: SubtaskStatus[] = ['merged', 'skipped'];

/** Backlogs and what hangs on them. JSON columns are arrays and maps here and nowhere else. */
@Injectable()
export class BacklogRepository implements BacklogWriters {
  private readonly writers: BacklogWriters;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly clock: Clock,
  ) {
    this.writers = writersOn(dataSource.manager, clock);
  }

  async listBacklogs(): Promise<BacklogRecord[]> {
    return (await this.dataSource.manager.find(BacklogEntity, { order: { id: 'ASC' } })).map(toBacklog);
  }

  async findBacklog(name: string): Promise<BacklogRecord | null> {
    const row = await this.dataSource.manager.findOne(BacklogEntity, { where: { name } });
    return row ? toBacklog(row) : null;
  }

  async milestones(backlogId: number): Promise<MilestoneRecord[]> {
    const rows = await this.dataSource.manager.find(MilestoneEntity, {
      where: { backlogId },
      order: { number: 'ASC' },
    });
    return rows.map(toMilestone);
  }

  async requirements(backlogId: number): Promise<RequirementRecord[]> {
    const milestones = await this.milestones(backlogId);
    if (milestones.length === 0) return [];
    const rows = await this.dataSource.manager.find(RequirementEntity, {
      where: { milestoneId: In(milestones.map((milestone) => milestone.id as number)) },
      order: { id: 'ASC' },
    });
    return rows.map(toRequirement);
  }

  /** The tasks of a backlog in plan order. */
  async tasks(backlogId: number): Promise<BacklogTaskRecord[]> {
    const rows = await this.dataSource.manager.find(BacklogTaskEntity, {
      where: { backlogId },
      order: { position: 'ASC', id: 'ASC' },
    });
    return rows.map(toTask);
  }

  async findTaskByRunKey(runKey: string): Promise<BacklogTaskRecord | null> {
    const row = await this.dataSource.manager.findOne(BacklogTaskEntity, { where: { runKey } });
    return row ? toTask(row) : null;
  }

  /** The backlog and milestone of each run key that a task holds; other keys are left out. */
  async labelsFor(runKeys: string[]): Promise<Map<string, RunBacklog>> {
    const labels = new Map<string, RunBacklog>();
    if (runKeys.length === 0) return labels;
    const manager = this.dataSource.manager;
    const tasks = await manager.find(BacklogTaskEntity, { where: { runKey: In(runKeys) } });
    const backlogs = new Map((await manager.find(BacklogEntity)).map((row) => [row.id, row.name]));
    const milestones = new Map((await manager.find(MilestoneEntity)).map((row) => [row.id, row.number]));
    for (const task of tasks) {
      const name = backlogs.get(task.backlogId);
      if (task.runKey === null || name === undefined) continue;
      labels.set(task.runKey, {
        name,
        milestone: task.milestoneId === null ? null : (milestones.get(task.milestoneId) ?? null),
      });
    }
    return labels;
  }

  async decisions(backlogId: number): Promise<DecisionRecord[]> {
    return this.dataSource.manager.find(DecisionEntity, { where: { backlogId }, order: { id: 'ASC' } });
  }

  /** The newest events first. */
  async events(backlogId: number, limit: number): Promise<BacklogEventRecord[]> {
    const rows = await this.dataSource.manager.find(BacklogEventEntity, {
      where: { backlogId },
      order: { id: 'DESC' },
      take: limit,
    });
    return rows.map(toEvent);
  }

  /** The kind of the newest main event (`main-red` or `main-green`) of a repository in a backlog, or null when there is none. */
  async latestMainEvent(backlogId: number, repository: string): Promise<'main-red' | 'main-green' | null> {
    const escaped = repository.replace(/[\\%_]/g, (char) => `\\${char}`);
    const row = await this.dataSource.manager
      .createQueryBuilder(BacklogEventEntity, 'event')
      .where('event.backlog_id = :backlogId', { backlogId })
      .andWhere("event.event_key LIKE :pattern ESCAPE '\\'", { pattern: `main-%:${escaped}:%` })
      .orderBy('event.id', 'DESC')
      .getOne();
    return row === null ? null : (row.kind as 'main-red' | 'main-green');
  }

  /** Tasks on the whole server that have a run and are not merged or skipped. */
  startedUnmergedCount(): Promise<number> {
    return this.dataSource.manager
      .createQueryBuilder(BacklogTaskEntity, 'task')
      .where('task.run_key IS NOT NULL')
      .andWhere('task.status NOT IN (:...finished)', { finished: FINISHED })
      .getCount();
  }

  saveBacklog(record: BacklogRecord): Promise<BacklogRecord> {
    return this.writers.saveBacklog(record);
  }

  saveMilestone(record: MilestoneRecord): Promise<MilestoneRecord> {
    return this.writers.saveMilestone(record);
  }

  saveRequirement(record: RequirementRecord): Promise<RequirementRecord> {
    return this.writers.saveRequirement(record);
  }

  saveTask(record: BacklogTaskRecord): Promise<BacklogTaskRecord> {
    return this.writers.saveTask(record);
  }

  addDecision(record: DecisionRecord): Promise<DecisionRecord> {
    return this.writers.addDecision(record);
  }

  deleteTask(id: number): Promise<void> {
    return this.writers.deleteTask(id);
  }

  recordEvent(backlogId: number, key: string, kind: BacklogEventKind, facts: Facts): Promise<boolean> {
    return this.writers.recordEvent(backlogId, key, kind, facts);
  }

  addMessage(record: BacklogMessageRecord): Promise<boolean> {
    return this.writers.addMessage(record);
  }

  saveTurn(record: BacklogTurnRecord): Promise<BacklogTurnRecord> {
    return this.writers.saveTurn(record);
  }

  /** Runs the work in one transaction; when it throws, nothing it wrote stays. */
  transaction<T>(work: (writers: BacklogWriters) => Promise<T>): Promise<T> {
    return transaction(this.dataSource, (manager) => work(writersOn(manager, this.clock)));
  }
}

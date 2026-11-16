import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { Clock } from '../core/clock';
import type {
  BacklogEventKind,
  MergeMode,
  MilestoneStatus,
  RequirementStatus,
  RunBacklog,
  TaskMadeBy,
} from '../contract/backlog';
import type { SubtaskStatus } from '../contract/subtask';
import {
  BacklogEntity,
  BacklogEventEntity,
  BacklogTaskEntity,
  DecisionEntity,
  MilestoneEntity,
  RequirementEntity,
} from './backlog.entities';
import { transaction } from './transaction';

type Facts = Record<string, string>;

interface BacklogRecord {
  id?: number;
  name: string;
  owner: string;
  repositories: string[];
  mergeMode: MergeMode;
  paused: boolean;
  createdAt: string;
}

interface MilestoneRecord {
  id?: number;
  backlogId: number;
  number: number;
  title: string;
  goal: string;
  status: MilestoneStatus;
  createdAt: string;
}

interface RequirementRecord {
  id?: number;
  milestoneId: number;
  ref: string;
  text: string;
  status: RequirementStatus;
}

export interface BacklogTaskRecord {
  id?: number;
  backlogId: number;
  milestoneId: number | null;
  slug: string;
  title: string;
  description: string;
  repositories: string[];
  covers: string[];
  depends: string[];
  files: string[];
  proof: string[];
  manual: boolean;
  fixesMain: string | null;
  status: SubtaskStatus;
  runKey: string | null;
  /** What the scheduler says about the task, in words. */
  note: string;
  /** The owner asked to run the task now: it joins the scheduler whatever its milestone. */
  runNow: boolean;
  /** The owner said this task may merge, for a `manual` task or a backlog in mode `ok`. */
  mergeOk: boolean;
  merged: Record<string, string>;
  madeBy: TaskMadeBy;
  position: number;
  createdAt: string;
}

interface DecisionRecord {
  id?: number;
  backlogId: number;
  text: string;
  who: string;
  createdAt: string;
}

interface BacklogEventRecord {
  id: number;
  backlogId: number;
  eventKey: string;
  kind: BacklogEventKind;
  facts: Facts;
  turn: string | null;
  createdAt: string;
}

/** The writes of a backlog; the same ones run alone or inside one transaction. */
interface BacklogWriters {
  saveBacklog(record: BacklogRecord): Promise<BacklogRecord>;
  saveMilestone(record: MilestoneRecord): Promise<MilestoneRecord>;
  saveRequirement(record: RequirementRecord): Promise<RequirementRecord>;
  saveTask(record: BacklogTaskRecord): Promise<BacklogTaskRecord>;
  addDecision(record: DecisionRecord): Promise<DecisionRecord>;
  /** Writes the event once per key; false when the key was written before. */
  recordEvent(backlogId: number, key: string, kind: BacklogEventKind, facts: Facts): Promise<boolean>;
}

const FINISHED: SubtaskStatus[] = ['merged', 'skipped'];

function toBacklog(row: BacklogEntity): BacklogRecord {
  return { ...row, repositories: JSON.parse(row.repositories) as string[], mergeMode: row.mergeMode as MergeMode };
}

function fromBacklog(record: BacklogRecord): BacklogEntity {
  return { id: record.id as number, ...record, repositories: JSON.stringify(record.repositories) };
}

function toMilestone(row: MilestoneEntity): MilestoneRecord {
  return { ...row, status: row.status as MilestoneStatus };
}

function toRequirement(row: RequirementEntity): RequirementRecord {
  return { ...row, status: row.status as RequirementStatus };
}

function toTask(row: BacklogTaskEntity): BacklogTaskRecord {
  return {
    ...row,
    repositories: JSON.parse(row.repositories) as string[],
    covers: JSON.parse(row.covers) as string[],
    depends: JSON.parse(row.depends) as string[],
    files: JSON.parse(row.files) as string[],
    proof: JSON.parse(row.proof) as string[],
    merged: JSON.parse(row.merged) as Record<string, string>,
    status: row.status as SubtaskStatus,
    madeBy: row.madeBy as TaskMadeBy,
  };
}

function fromTask(record: BacklogTaskRecord): BacklogTaskEntity {
  return {
    ...record,
    id: record.id as number,
    repositories: JSON.stringify(record.repositories),
    covers: JSON.stringify(record.covers),
    depends: JSON.stringify(record.depends),
    files: JSON.stringify(record.files),
    proof: JSON.stringify(record.proof),
    merged: JSON.stringify(record.merged),
  };
}

function toEvent(row: BacklogEventEntity): BacklogEventRecord {
  return { ...row, kind: row.kind as BacklogEventKind, facts: JSON.parse(row.facts) as Facts };
}

async function saveRow<Row extends { id: number }>(
  manager: EntityManager,
  target: new () => Row,
  row: Row,
): Promise<Row> {
  const { id, ...fields } = row;
  if (id) {
    await manager.update(target, id, fields as never);
    return row;
  }
  const inserted = await manager.insert(target, fields as never);
  return { ...row, id: Number(inserted.identifiers[0]?.id) };
}

function writersOn(manager: EntityManager, clock: Clock): BacklogWriters {
  return {
    async saveBacklog(record) {
      return toBacklog(await saveRow(manager, BacklogEntity, fromBacklog(record)));
    },
    async saveMilestone(record) {
      return toMilestone(await saveRow(manager, MilestoneEntity, { ...record, id: record.id as number }));
    },
    async saveRequirement(record) {
      return toRequirement(await saveRow(manager, RequirementEntity, { ...record, id: record.id as number }));
    },
    async saveTask(record) {
      return toTask(await saveRow(manager, BacklogTaskEntity, fromTask(record)));
    },
    async addDecision(record) {
      return saveRow(manager, DecisionEntity, { ...record, id: record.id as number });
    },
    async recordEvent(backlogId, key, kind, facts) {
      try {
        await manager.insert(BacklogEventEntity, {
          backlogId,
          eventKey: key,
          kind,
          facts: JSON.stringify(facts),
          turn: null,
          createdAt: clock.iso(),
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
        throw error;
      }
      return true;
    },
  };
}

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

  recordEvent(backlogId: number, key: string, kind: BacklogEventKind, facts: Facts): Promise<boolean> {
    return this.writers.recordEvent(backlogId, key, kind, facts);
  }

  /** Runs the work in one transaction; when it throws, nothing it wrote stays. */
  transaction<T>(work: (writers: BacklogWriters) => Promise<T>): Promise<T> {
    return transaction(this.dataSource, (manager) => work(writersOn(manager, this.clock)));
  }
}

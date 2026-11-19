import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import type { Clock } from '../core/clock';
import type { BacklogEventKind, MergeMode, MilestoneStatus, RequirementStatus, TaskMadeBy } from '../contract/backlog';
import type { MessageAuthor, TurnStatus } from '../contract/backlog-chat';
import type { SubtaskStatus } from '../contract/subtask';
import {
  BacklogEntity,
  BacklogEventEntity,
  BacklogTaskEntity,
  DecisionEntity,
  MilestoneEntity,
  RequirementEntity,
} from './backlog.entities';
import { BacklogMessageEntity, BacklogTurnEntity } from './backlog-planner.entities';

export type Facts = Record<string, string>;

export interface BacklogRecord {
  id?: number;
  name: string;
  owner: string;
  repositories: string[];
  mergeMode: MergeMode;
  paused: boolean;
  createdAt: string;
}

export interface MilestoneRecord {
  id?: number;
  backlogId: number;
  number: number;
  title: string;
  goal: string;
  status: MilestoneStatus;
  /** The milestone whose acceptance starts this queued one. */
  queuedAfterId?: number | null;
  createdAt: string;
}

export interface RequirementRecord {
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

export interface DecisionRecord {
  id?: number;
  backlogId: number;
  text: string;
  who: string;
  createdAt: string;
}

export interface BacklogEventRecord {
  id: number;
  backlogId: number;
  eventKey: string;
  kind: BacklogEventKind;
  facts: Facts;
  turn: string | null;
  createdAt: string;
}

export interface BacklogMessageRecord {
  id?: number;
  backlogId: number;
  /** One message is written once per backlog and key. */
  messageKey: string;
  author: MessageAuthor;
  text: string;
  /** The planner offers a milestone to run with this message. */
  proposes: boolean;
  /** The key of the turn the message belongs to; empty while it waits. */
  turn: string | null;
  createdAt: string;
}

export interface BacklogTurnRecord {
  id?: number;
  backlogId: number;
  turnKey: string;
  status: TurnStatus;
  /** Why a turn failed or waits, in plain words. */
  reason: string;
  nextTryAt: string | null;
  createdAt: string;
  /** What the turn's agent visits used; unset until the turn launches. */
  runtime?: string;
  model?: string;
  effort?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
  durationMs?: number;
  transcript?: string;
}

/** The writes of a backlog, and the reads its actions use; the same ones run alone or inside one transaction. */
export interface BacklogWriters {
  saveBacklog(record: BacklogRecord): Promise<BacklogRecord>;
  saveMilestone(record: MilestoneRecord): Promise<MilestoneRecord>;
  saveRequirement(record: RequirementRecord): Promise<RequirementRecord>;
  saveTask(record: BacklogTaskRecord): Promise<BacklogTaskRecord>;
  addDecision(record: DecisionRecord): Promise<DecisionRecord>;
  deleteTask(id: number): Promise<void>;
  /** Writes the event once per key; false when the key was written before. */
  recordEvent(backlogId: number, key: string, kind: BacklogEventKind, facts: Facts): Promise<boolean>;
  /** Writes the message once per backlog and key; false when the key was written before. */
  addMessage(record: BacklogMessageRecord): Promise<boolean>;
  saveTurn(record: BacklogTurnRecord): Promise<BacklogTurnRecord>;
  findBacklog(name: string): Promise<BacklogRecord | null>;
  milestones(backlogId: number): Promise<MilestoneRecord[]>;
  requirements(backlogId: number): Promise<RequirementRecord[]>;
  tasks(backlogId: number): Promise<BacklogTaskRecord[]>;
  decisions(backlogId: number): Promise<DecisionRecord[]>;
}

export function toBacklog(row: BacklogEntity): BacklogRecord {
  return { ...row, repositories: JSON.parse(row.repositories) as string[], mergeMode: row.mergeMode as MergeMode };
}

function fromBacklog(record: BacklogRecord): BacklogEntity {
  return { id: record.id as number, ...record, repositories: JSON.stringify(record.repositories) };
}

export function toMilestone(row: MilestoneEntity): MilestoneRecord {
  return { ...row, status: row.status as MilestoneStatus };
}

export function toRequirement(row: RequirementEntity): RequirementRecord {
  return { ...row, status: row.status as RequirementStatus };
}

export function toTask(row: BacklogTaskEntity): BacklogTaskRecord {
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

export function toEvent(row: BacklogEventEntity): BacklogEventRecord {
  return { ...row, kind: row.kind as BacklogEventKind, facts: JSON.parse(row.facts) as Facts };
}

export function toMessage(row: BacklogMessageEntity): BacklogMessageRecord {
  return { ...row, author: row.author as MessageAuthor };
}

export function toTurn(row: BacklogTurnEntity): BacklogTurnRecord {
  return { ...row, status: row.status as TurnStatus };
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

export function writersOn(manager: EntityManager, clock: Clock): BacklogWriters {
  const milestones = async (backlogId: number) =>
    (await manager.find(MilestoneEntity, { where: { backlogId }, order: { number: 'ASC' } })).map(toMilestone);
  return {
    async saveBacklog(record) {
      return toBacklog(await saveRow(manager, BacklogEntity, fromBacklog(record)));
    },
    async saveMilestone(record) {
      return toMilestone(
        await saveRow(manager, MilestoneEntity, {
          ...record,
          queuedAfterId: record.queuedAfterId ?? null,
          id: record.id as number,
        }),
      );
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
    async deleteTask(id) {
      await manager.delete(BacklogTaskEntity, id);
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
    async addMessage(record) {
      try {
        await manager.insert(BacklogMessageEntity, record);
      } catch (error) {
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
        throw error;
      }
      return true;
    },
    async saveTurn(record) {
      // A field a turn does not set yet stays out of the insert, so the column keeps its default.
      return toTurn(
        await saveRow(manager, BacklogTurnEntity, { ...record, id: record.id as number } as BacklogTurnEntity),
      );
    },
    async findBacklog(name) {
      const row = await manager.findOne(BacklogEntity, { where: { name } });
      return row ? toBacklog(row) : null;
    },
    milestones,
    async requirements(backlogId) {
      const owned = await milestones(backlogId);
      if (owned.length === 0) return [];
      const rows = await manager.find(RequirementEntity, {
        where: { milestoneId: In(owned.map((milestone) => milestone.id as number)) },
        order: { id: 'ASC' },
      });
      return rows.map(toRequirement);
    },
    async tasks(backlogId) {
      const rows = await manager.find(BacklogTaskEntity, {
        where: { backlogId },
        order: { position: 'ASC', id: 'ASC' },
      });
      return rows.map(toTask);
    },
    async decisions(backlogId) {
      return manager.find(DecisionEntity, { where: { backlogId }, order: { id: 'ASC' } });
    },
  };
}

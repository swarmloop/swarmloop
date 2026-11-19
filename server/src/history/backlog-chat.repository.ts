import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { In, IsNull, Not } from 'typeorm';
import { Clock } from '../core/clock';
import type { TurnStatus } from '../contract/backlog-chat';
import { BacklogEventEntity } from './backlog.entities';
import { BacklogMessageEntity, BacklogTurnEntity } from './backlog-planner.entities';
import {
  toEvent,
  toMessage,
  toTurn,
  writersOn,
  type BacklogEventRecord,
  type BacklogMessageRecord,
  type BacklogTurnRecord,
} from './backlog-writers';
import { transaction } from './transaction';

/** The record of what a person or the planner did is state the planner reads, never an event that wakes it. */
const ACTION_RECORD = 'action';

/** A person's messages and events that no turn has finished, together. */
interface WaitingItems {
  messages: BacklogMessageRecord[];
  events: BacklogEventRecord[];
}

/** The last messages of a conversation, oldest first, and how many came before them. */
interface RecentMessages {
  messages: BacklogMessageRecord[];
  older: number;
}

/** The conversation of each backlog with its planner, its turns, and the items that wait for a turn. */
@Injectable()
export class BacklogChatRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly clock: Clock,
  ) {}

  /** Writes a person's message once per key; false when the key was written before. */
  addPersonMessage(backlogId: number, text: string, key: string): Promise<boolean> {
    return writersOn(this.dataSource.manager, this.clock).addMessage({
      backlogId,
      messageKey: key,
      author: 'person',
      text,
      proposes: false,
      turn: null,
      createdAt: this.clock.iso(),
    });
  }

  async lastMessages(backlogId: number, count: number): Promise<RecentMessages> {
    const manager = this.dataSource.manager;
    const rows = await manager.find(BacklogMessageEntity, {
      where: { backlogId },
      order: { id: 'DESC' },
      take: count,
    });
    const total = await manager.count(BacklogMessageEntity, { where: { backlogId } });
    return { messages: rows.reverse().map(toMessage), older: total - rows.length };
  }

  /** The person's messages and the events with no turn, or whose turn failed. */
  async waitingItems(backlogId: number): Promise<WaitingItems> {
    const failed = await this.failedKeys(backlogId);
    const turnless = [IsNull(), ...(failed.length > 0 ? [In(failed)] : [])];
    const manager = this.dataSource.manager;
    const messages = await manager.find(BacklogMessageEntity, {
      where: turnless.map((turn) => ({ backlogId, author: 'person', turn })),
      order: { id: 'ASC' },
    });
    const events = await manager.find(BacklogEventEntity, {
      where: turnless.map((turn) => ({ backlogId, kind: Not(ACTION_RECORD), turn })),
      order: { id: 'ASC' },
    });
    return { messages: messages.map(toMessage), events: events.map(toEvent) };
  }

  /** Gives every waiting message and event to the turn, together. Returns what the turn took. */
  async takeInto(backlogId: number, turnKey: string): Promise<WaitingItems> {
    return transaction(this.dataSource, async (manager) => {
      const failed = await this.failedKeys(backlogId, manager);
      const turnless = [IsNull(), ...(failed.length > 0 ? [In(failed)] : [])];
      for (const turn of turnless) {
        await manager.update(BacklogMessageEntity, { backlogId, author: 'person', turn }, { turn: turnKey });
        await manager.update(BacklogEventEntity, { backlogId, kind: Not(ACTION_RECORD), turn }, { turn: turnKey });
      }
      return this.itemsOfTurn(turnKey, manager);
    });
  }

  async itemsOfTurn(turnKey: string, manager = this.dataSource.manager): Promise<WaitingItems> {
    const messages = await manager.find(BacklogMessageEntity, {
      where: { turn: turnKey, author: 'person' },
      order: { id: 'ASC' },
    });
    const events = await manager.find(BacklogEventEntity, { where: { turn: turnKey }, order: { id: 'ASC' } });
    return { messages: messages.map(toMessage), events: events.map(toEvent) };
  }

  saveTurn(record: BacklogTurnRecord): Promise<BacklogTurnRecord> {
    return writersOn(this.dataSource.manager, this.clock).saveTurn(record);
  }

  async findTurn(turnKey: string): Promise<BacklogTurnRecord | null> {
    const row = await this.dataSource.manager.findOne(BacklogTurnEntity, { where: { turnKey } });
    return row ? toTurn(row) : null;
  }

  async turnsByStatus(statuses: TurnStatus[]): Promise<BacklogTurnRecord[]> {
    const rows = await this.dataSource.manager.find(BacklogTurnEntity, {
      where: { status: In(statuses) },
      order: { id: 'ASC' },
    });
    return rows.map(toTurn);
  }

  /** The backlogs that have a person's message or an event waiting for a turn, in id order. */
  async backlogsWithWaitingWork(): Promise<number[]> {
    const manager = this.dataSource.manager;
    const failed = (await manager.find(BacklogTurnEntity, { where: { status: 'failed' } })).map((row) => row.turnKey);
    const turnless = [IsNull(), ...(failed.length > 0 ? [In(failed)] : [])];
    const messages = await manager.find(BacklogMessageEntity, {
      where: turnless.map((turn) => ({ author: 'person', turn })),
    });
    const events = await manager.find(BacklogEventEntity, {
      where: turnless.map((turn) => ({ kind: Not(ACTION_RECORD), turn })),
    });
    const ids = new Set([...messages, ...events].map((item) => item.backlogId));
    return [...ids].sort((left, right) => left - right);
  }

  /** The slugs of merged tasks whose `task-merged` event no finished turn has handled yet. */
  async unhandledMergedSlugs(backlogId: number): Promise<string[]> {
    const events = await this.dataSource.manager.find(BacklogEventEntity, {
      where: { backlogId, kind: 'task-merged' },
      order: { id: 'ASC' },
    });
    const done = await this.doneKeys(backlogId);
    const slugs: string[] = [];
    for (const event of events) {
      if (event.turn !== null && done.has(event.turn)) continue;
      const slug = (JSON.parse(event.facts) as Record<string, string>).slug;
      if (slug !== undefined) slugs.push(slug);
    }
    return slugs;
  }

  private async failedKeys(backlogId: number, manager = this.dataSource.manager): Promise<string[]> {
    const rows = await manager.find(BacklogTurnEntity, { where: { backlogId, status: 'failed' } });
    return rows.map((row) => row.turnKey);
  }

  private async doneKeys(backlogId: number): Promise<Set<string>> {
    const rows = await this.dataSource.manager.find(BacklogTurnEntity, { where: { backlogId, status: 'done' } });
    return new Set(rows.map((row) => row.turnKey));
  }
}

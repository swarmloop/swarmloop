import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { In, IsNull, Not } from 'typeorm';
import type { AttachmentRef } from '../contract/attachments';
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

/** Matches the rows no turn has taken, and the rows of the given turns when there are any. */
function waiting<Match extends object>(match: Match, from: string[]) {
  return from.length === 0
    ? { ...match, turn: IsNull() }
    : [
        { ...match, turn: IsNull() },
        { ...match, turn: In(from) },
      ];
}

/** A person's messages and events that no turn has taken, together. */
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

  /** Writes a person's message once per key; null when the key was written before. */
  async addPersonMessage(
    backlogId: number,
    text: string,
    key: string,
    attachments: AttachmentRef[],
  ): Promise<BacklogMessageRecord | null> {
    const manager = this.dataSource.manager;
    const stored = await writersOn(manager, this.clock).addMessage({
      backlogId,
      messageKey: key,
      author: 'person',
      kind: 'message',
      text,
      proposes: null,
      turn: null,
      attachments,
      createdAt: this.clock.iso(),
    });
    if (!stored) return null;
    return toMessage(await manager.findOneOrFail(BacklogMessageEntity, { where: { backlogId, messageKey: key } }));
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

  /** The person's messages and the events no turn has taken, and those of the given failed turns, which wait with them. */
  async waitingItems(backlogId: number, from: string[] = []): Promise<WaitingItems> {
    const manager = this.dataSource.manager;
    const messages = await manager.find(BacklogMessageEntity, {
      where: waiting({ backlogId, author: 'person' }, from),
      order: { id: 'ASC' },
    });
    const events = await manager.find(BacklogEventEntity, {
      where: waiting({ backlogId, kind: Not(ACTION_RECORD) }, from),
      order: { id: 'ASC' },
    });
    return { messages: messages.map(toMessage), events: events.map(toEvent) };
  }

  /** Gives every waiting message and event, and those of the given failed turns, to the turn, together. Returns what the turn took. */
  async takeInto(backlogId: number, turnKey: string, from: string[] = []): Promise<WaitingItems> {
    return transaction(this.dataSource, async (manager) => {
      await manager.update(BacklogMessageEntity, waiting({ backlogId, author: 'person' }, from), { turn: turnKey });
      await manager.update(BacklogEventEntity, waiting({ backlogId, kind: Not(ACTION_RECORD) }, from), {
        turn: turnKey,
      });
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

  /** The seen state of the backlog's newest turn that has one, else null. */
  async lastSeenState(backlogId: number): Promise<string | null> {
    const row = await this.dataSource.manager.findOne(BacklogTurnEntity, {
      where: { backlogId, seenState: Not(IsNull()) },
      order: { id: 'DESC' },
    });
    return row?.seenState ?? null;
  }

  /** The turns of one backlog, oldest first. */
  async turnsOf(backlogId: number): Promise<BacklogTurnRecord[]> {
    const rows = await this.dataSource.manager.find(BacklogTurnEntity, { where: { backlogId }, order: { id: 'ASC' } });
    return rows.map(toTurn);
  }

  /** The backlogs that have a person's message or an event waiting for a turn, those of the given failed turns included, in id order. */
  async backlogsWithWaitingWork(from: string[] = []): Promise<number[]> {
    const manager = this.dataSource.manager;
    const messages = await manager.find(BacklogMessageEntity, { where: waiting({ author: 'person' }, from) });
    const events = await manager.find(BacklogEventEntity, { where: waiting({ kind: Not(ACTION_RECORD) }, from) });
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

  private async doneKeys(backlogId: number): Promise<Set<string>> {
    const rows = await this.dataSource.manager.find(BacklogTurnEntity, { where: { backlogId, status: 'done' } });
    return new Set(rows.map((row) => row.turnKey));
  }
}

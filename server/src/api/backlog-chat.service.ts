import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { BacklogChatView } from '../contract/backlog-chat';
import { SwarmloopError } from '../core/swarmloop-error';
import { LiveHub } from '../live/live.hub';
import { BacklogChatRepository } from '../history/backlog-chat.repository';
import { BacklogActionSupport } from '../pipeline/backlog/backlog-action-support';
import { checkText } from '../pipeline/backlog/backlog-rules';
import { BacklogPlanner, NoFailedTurn } from '../pipeline/backlog/planner/backlog-planner';
import { messageView, turnView } from '../pipeline/backlog/planner/planner-views';

/** How many of the latest messages the chat answer carries; the answer says how many older ones it leaves out. */
const SHOWN_MESSAGES = 100;

/** The conversation of a backlog with its planner: a person's messages in, the messages and the turns out. */
@Injectable()
export class BacklogChatService {
  constructor(
    private readonly support: BacklogActionSupport,
    private readonly chats: BacklogChatRepository,
    private readonly planner: BacklogPlanner,
    @Optional() private readonly live?: LiveHub,
  ) {}

  /** The owner's message, stored once per request; a newly stored message is shown live and wakes the planner. */
  async post(actor: string | null, name: string, text: unknown, idempotencyKey?: string): Promise<BacklogChatView> {
    const { backlog } = await this.support.owned(actor, name);
    const clean = checkText(text, 'the message');
    const key = `message-${idempotencyKey?.trim() || randomUUID()}`;
    const stored = await this.chats.addPersonMessage(backlog.id as number, clean, key);
    if (stored) {
      this.live?.backlog({ backlog: name, message: messageView(stored) });
      this.planner.wake(backlog.id as number);
    }
    return this.chat(name);
  }

  async chat(name: string): Promise<BacklogChatView> {
    const backlog = await this.support.load(name);
    const id = backlog.id as number;
    const recent = await this.chats.lastMessages(id, SHOWN_MESSAGES);
    const turns = await this.chats.turnsOf(id);
    return {
      messages: recent.messages.map(messageView),
      older: recent.older,
      turns: turns.map(turnView),
    };
  }

  /** The owner reruns the failed turn with the items it took. */
  async resume(actor: string | null, name: string): Promise<BacklogChatView> {
    await this.support.owned(actor, name);
    try {
      await this.planner.resume(name);
    } catch (error) {
      if (error instanceof NoFailedTurn) throw new NotFoundException(error.message);
      if (error instanceof SwarmloopError) throw new ConflictException(error.message);
      throw error;
    }
    return this.chat(name);
  }
}

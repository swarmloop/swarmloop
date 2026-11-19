import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { SwarmloopError } from '../core/swarmloop-error';
import type { BacklogChatRepository } from '../history/backlog-chat.repository';
import type { BacklogMessageRecord, BacklogTurnRecord } from '../history/backlog-writers';
import type { BacklogRepository } from '../history/backlog.repository';
import { BacklogActionSupport } from '../pipeline/backlog/backlog-action-support';
import { NoFailedTurn, type BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { BacklogChatController } from './backlog-chat.controller';
import { BacklogChatService } from './backlog-chat.service';
import type { Clock } from '../core/clock';
import type { LiveBacklog } from '../contract/backlog-chat';
import type { LiveHub } from '../live/live.hub';

function setup(resumeError?: Error) {
  const messages: BacklogMessageRecord[] = [];
  const turns: BacklogTurnRecord[] = [];
  const woken: number[] = [];
  const resumed: string[] = [];
  const shown: LiveBacklog[] = [];
  const live = { backlog: (entry: LiveBacklog) => shown.push(entry) };
  const backlogs = {
    findBacklog: async (name: string) => (name === 'shop' ? { id: 7, name, owner: 'ada' } : null),
  };
  const chats = {
    addPersonMessage: async (backlogId: number, text: string, key: string) => {
      if (messages.some((message) => message.messageKey === key)) return null;
      messages.push({
        id: messages.length + 1,
        backlogId,
        messageKey: key,
        author: 'person',
        kind: 'message',
        text,
        proposes: null,
        turn: null,
        createdAt: 'now',
      });
      return messages[messages.length - 1];
    },
    lastMessages: async () => ({ messages, older: 3 }),
    turnsOf: async (backlogId: number) => turns.filter((turn) => turn.backlogId === backlogId),
  };
  const planner = {
    wake: (id: number) => woken.push(id),
    resume: async (name: string) => {
      resumed.push(name);
      if (resumeError) throw resumeError;
    },
  };
  const support = new BacklogActionSupport(backlogs as unknown as BacklogRepository, {} as Clock);
  const service = new BacklogChatService(
    support,
    chats as unknown as BacklogChatRepository,
    planner as unknown as BacklogPlanner,
    live as unknown as LiveHub,
  );
  return { routes: new BacklogChatController(service), messages, turns, woken, resumed, shown };
}

describe('BacklogChatController', () => {
  it('refuses an anonymous caller and a person who is not the owner, and stores and wakes nothing', async () => {
    const { routes, messages, woken } = setup();
    await expect(routes.post(null, 'shop', { text: 'hi' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(routes.post('bob', 'shop', { text: 'hi' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(routes.resume(null, 'shop')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(routes.resume('bob', 'shop')).rejects.toBeInstanceOf(ForbiddenException);
    expect(messages).toEqual([]);
    expect(woken).toEqual([]);
  });

  it('stores the owner text trimmed once per request and wakes the planner once', async () => {
    const { routes, messages, woken, shown } = setup();
    const first = await routes.post('ada', 'shop', { text: '  plan it  ' }, 'req-1');
    await routes.post('ada', 'shop', { text: '  plan it  ' }, 'req-1');
    expect(shown.map((entry) => [entry.backlog, entry.message?.author, entry.message?.text])).toEqual([
      ['shop', 'person', 'plan it'],
    ]);
    expect(messages.map((message) => [message.messageKey, message.text])).toEqual([['message-req-1', 'plan it']]);
    expect(woken).toEqual([7]);
    expect(first.messages).toHaveLength(1);
  });

  it('stores two messages that come without a key', async () => {
    const { routes, messages } = setup();
    await routes.post('ada', 'shop', { text: 'one' });
    await routes.post('ada', 'shop', { text: 'one' });
    expect(messages).toHaveLength(2);
  });

  it('refuses an empty text and an unknown backlog', async () => {
    const { routes } = setup();
    await expect(routes.post('ada', 'shop', { text: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(routes.post('ada', 'nope', { text: 'hi' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(routes.messages('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows the messages with what they propose, how many are older, and the turns with their use', async () => {
    const { routes, messages, turns } = setup();
    messages.push({
      id: 1,
      backlogId: 7,
      messageKey: 'k',
      author: 'planner',
      kind: 'message',
      text: 'Run it?',
      proposes: 2,
      turn: 't1',
      createdAt: 'now',
    });
    turns.push(
      {
        backlogId: 7,
        turnKey: 't1',
        status: 'done',
        reason: '',
        nextTryAt: null,
        createdAt: 'then',
        runtime: 'claude',
        model: 'opus',
        effort: 'high',
        tokensIn: 10,
        tokensOut: 20,
        usd: 0.5,
        durationMs: 1500,
      },
      { backlogId: 8, turnKey: 'other', status: 'done', reason: '', nextTryAt: null, createdAt: 'then' },
    );
    const chat = await routes.messages('shop');
    expect(chat.older).toBe(3);
    expect(chat.messages).toEqual([
      { id: 1, author: 'planner', kind: 'message', text: 'Run it?', proposes: 2, createdAt: 'now' },
    ]);
    expect(chat.turns).toEqual([
      {
        status: 'done',
        reason: '',
        nextTryAt: null,
        runtime: 'claude',
        model: 'opus',
        effort: 'high',
        tokensIn: 10,
        tokensOut: 20,
        usd: 0.5,
        durationMs: 1500,
        startedAt: 'then',
      },
    ]);
  });

  it('asks the planner to rerun the failed turn and answers the chat', async () => {
    const { routes, resumed } = setup();
    expect((await routes.resume('ada', 'shop')).messages).toEqual([]);
    expect(resumed).toEqual(['shop']);
  });

  it('answers 404 when the backlog has no failed turn', async () => {
    const { routes } = setup(new NoFailedTurn('shop has no failed turn to resume'));
    await expect(routes.resume('ada', 'shop')).rejects.toEqual(
      new NotFoundException('shop has no failed turn to resume'),
    );
  });

  it('answers 409 with the reason while the planner works on a turn', async () => {
    const { routes } = setup(new SwarmloopError('shop: the planner is working on a turn'));
    await expect(routes.resume('ada', 'shop')).rejects.toEqual(
      new ConflictException('shop: the planner is working on a turn'),
    );
  });
});

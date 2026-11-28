import { describe, expect, it } from 'vitest';
import { backlogChatView, backlogView, chatMessage, milestone, task } from '../../../test/backlog-fixtures';
import { chatRows, liveOffers } from './chat-rows';

describe('chatRows', () => {
  it('orders messages and by-hand actions by time, newest last, and leaves out the planner’s own actions', () => {
    const view = backlogView({
      events: [
        { kind: 'action', facts: { action: 'pause', who: 'ada' }, at: '2026-01-01T10:05:00.000Z' },
        { kind: 'action', facts: { action: 'pause', who: 'ada', via: 'the planner' }, at: '2026-01-01T10:06:00.000Z' },
      ],
    });
    const chat = backlogChatView({
      messages: [
        chatMessage({ id: 2, author: 'planner', text: 'Done', createdAt: '2026-01-01T10:10:00.000Z' }),
        chatMessage({ id: 1, text: 'Hi', createdAt: '2026-01-01T10:00:00.000Z' }),
      ],
    });

    const rows = chatRows(chat, view, 'ada');

    expect(rows.map((row) => row.key)).toEqual(['message-1', 'action-0', 'message-2']);
    expect(rows[1]).toMatchObject({ type: 'info', sentence: 'ada paused the backlog.' });
  });

  it('puts a line first that says how many older messages are left out', () => {
    const rows = chatRows(backlogChatView({ older: 3 }), backlogView(), 'ada');

    expect(rows[0]).toEqual({ type: 'older', key: 'older', sentence: '3 older messages are left out.' });
  });

  it('names task titles, never slugs, in an action', () => {
    const view = backlogView({
      events: [
        {
          kind: 'action',
          facts: { action: 'skip task', who: 'ada', task: 'pay-by-card' },
          at: '2026-01-01T10:05:00.000Z',
        },
      ],
    });

    const rows = chatRows(backlogChatView({ messages: [] }), view, 'ada');

    expect(rows).toEqual([{ type: 'info', key: 'action-0', sentence: 'ada skipped “Pay by card”.' }]);
  });

  it('marks a proposal only while its milestone is proposed, and the lowest one as first', () => {
    const view = backlogView({
      milestones: [
        milestone({ number: 4, status: 'proposed' }),
        milestone({ number: 5, status: 'proposed' }),
        milestone({ number: 6, status: 'queued' }),
      ],
    });
    const chat = backlogChatView({
      messages: [
        chatMessage({ id: 1, author: 'planner', proposes: 5, createdAt: '2026-01-01T10:00:00.000Z' }),
        chatMessage({ id: 2, author: 'planner', proposes: 4, createdAt: '2026-01-01T10:01:00.000Z' }),
        chatMessage({ id: 3, author: 'planner', proposes: 6, createdAt: '2026-01-01T10:02:00.000Z' }),
      ],
    });

    const rows = chatRows(chat, view, 'ada');

    expect(rows.map((row) => [row.type, row.type === 'proposal' ? row.offers : null])).toEqual([
      ['proposal', [{ kind: 'milestone', number: 5, first: false }]],
      ['proposal', [{ kind: 'milestone', number: 4, first: true }]],
      ['message', null],
    ]);
  });

  it('gives a plain planner message its live offers, and a person message none', () => {
    const view = backlogView({ milestones: [milestone({ number: 4, status: 'proposed' })] });
    const chat = backlogChatView({
      messages: [
        chatMessage({ id: 1, author: 'planner', offers: [{ milestone: 4 }] }),
        chatMessage({ id: 2, author: 'person', offers: [{ milestone: 4 }] }),
      ],
    });

    const rows = chatRows(chat, view, 'ada');

    expect(rows.map((row) => (row.type === 'message' ? row.offers : null))).toEqual([
      [{ kind: 'milestone', number: 4, first: true }],
      [],
    ]);
  });

  it('shows the last turn: failed with Resume for the owner only, running as the working row', () => {
    const failed = backlogChatView({
      messages: [],
      turns: [{ status: 'failed', reason: 'It broke', nextTryAt: null }],
    });
    const running = backlogChatView({
      messages: [],
      turns: [
        { status: 'failed', reason: 'x', nextTryAt: null },
        { status: 'running', reason: '', nextTryAt: null },
      ],
    });

    expect(chatRows(failed, backlogView(), 'ada')).toMatchObject([
      { type: 'problem', reason: 'It broke', resume: true },
    ]);
    expect(chatRows(failed, backlogView(), 'bob')).toMatchObject([{ type: 'problem', resume: false }]);
    expect(chatRows(running, backlogView(), 'ada')).toEqual([{ type: 'working', key: 'turn', startedAt: null }]);
  });

  it('shows what the start of a running turn waits for, and the working row once it does not', () => {
    const place = 'Waiting for a free agent place (4 of 4 busy)';
    const waiting = backlogChatView({ messages: [], turns: [{ status: 'running', reason: place, nextTryAt: null }] });
    expect(chatRows(waiting, backlogView(), 'ada')).toEqual([{ type: 'info', key: 'turn', sentence: place }]);
    expect(chatRows(waiting, backlogView(), 'ada').some((row) => row.type === 'working')).toBe(false);
    const started = backlogChatView({ messages: [], turns: [{ status: 'running', reason: '', nextTryAt: null }] });
    expect(chatRows(started, backlogView(), 'ada')).toEqual([{ type: 'working', key: 'turn', startedAt: null }]);
  });

  it('shows a waiting turn and an applied turn that waits for a host with their next try, not the working row', () => {
    const next = '2026-11-22T14:36:41.506Z';
    const reason = 'github.com did not answer';
    const info = [{ type: 'info', key: 'turn', sentence: expect.stringContaining('The planner tries again at') }];
    for (const status of ['waiting', 'applied'] as const) {
      const view = backlogChatView({ messages: [], turns: [{ status, reason, nextTryAt: next }] });
      expect(chatRows(view, backlogView(), 'ada')).toEqual(info);
    }
    const applied = backlogChatView({ messages: [], turns: [{ status: 'applied', reason: '', nextTryAt: null }] });
    expect(chatRows(applied, backlogView(), 'ada')).toEqual([{ type: 'working', key: 'turn', startedAt: null }]);
  });

  it('ends the rows with the working row of a running turn, with the time it started', () => {
    const startedAt = '2026-01-01T10:00:00.000Z';
    const chat = backlogChatView({
      messages: [chatMessage({ id: 1, text: 'Hi', createdAt: '2026-01-01T09:00:00.000Z' })],
      turns: [{ status: 'running', reason: '', nextTryAt: null, startedAt }],
    });

    expect(chatRows(chat, backlogView(), 'ada').map((row) => row.type)).toEqual(['message', 'working']);
    expect(chatRows(chat, backlogView(), 'ada').at(-1)).toEqual({ type: 'working', key: 'turn', startedAt });
  });
});

describe('liveOffers', () => {
  const planner = (overrides: Parameters<typeof chatMessage>[0]) => chatMessage({ author: 'planner', ...overrides });

  it('counts the milestone a message proposes as an offer, once, with the offered ones', () => {
    const view = backlogView({ milestones: [milestone({ number: 4, status: 'proposed' })], tasks: [] });

    expect(liveOffers(planner({ proposes: 4, offers: [{ milestone: 4 }] }), view, 4)).toEqual([
      { kind: 'milestone', number: 4, first: true },
    ]);
  });

  it('drops an offered milestone once it is no longer proposed, and marks only the first proposed', () => {
    const view = backlogView({
      milestones: [
        milestone({ number: 3, status: 'accepted' }),
        milestone({ number: 4, status: 'proposed' }),
        milestone({ number: 5, status: 'proposed' }),
      ],
    });

    expect(liveOffers(planner({ offers: [{ milestone: 3 }, { milestone: 4 }, { milestone: 5 }] }), view, 4)).toEqual([
      { kind: 'milestone', number: 4, first: true },
      { kind: 'milestone', number: 5, first: false },
    ]);
  });

  it('keeps an offered task only while it has not started, is not settled and is outside the active milestone', () => {
    const view = backlogView({
      tasks: [
        task({ slug: 'idle', title: 'Idle one', status: 'waiting', milestone: null }),
        task({ slug: 'going', status: 'running', runKey: 'going-1', milestone: null }),
        task({ slug: 'dropped', status: 'skipped', milestone: null }),
        task({ slug: 'done', status: 'merged', milestone: null }),
        task({ slug: 'inside', status: 'waiting', milestone: 3 }),
      ],
    });
    const offers = ['idle', 'going', 'dropped', 'done', 'inside', 'missing'].map((slug) => ({ task: slug }));

    expect(liveOffers(planner({ offers }), view, undefined)).toEqual([
      { kind: 'task', slug: 'idle', title: 'Idle one' },
    ]);
  });
});

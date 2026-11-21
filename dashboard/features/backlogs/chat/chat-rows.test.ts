import { describe, expect, it } from 'vitest';
import { backlogChatView, backlogView, chatMessage, milestone } from '../../../test/backlog-fixtures';
import { chatRows } from './chat-rows';

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

    expect(rows.map((row) => [row.type, row.type === 'proposal' ? row.first : null])).toEqual([
      ['proposal', false],
      ['proposal', true],
      ['message', null],
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
    expect(chatRows(running, backlogView(), 'ada')).toEqual([{ type: 'working', key: 'turn' }]);
  });
});

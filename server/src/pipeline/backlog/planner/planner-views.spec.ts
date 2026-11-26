import type { TurnStatus } from '../../../contract/backlog-chat';
import type { BacklogMessageRecord, BacklogTurnRecord } from '../../../history/backlog-writers';
import { messageState, messageView } from './planner-views';

function message(author: 'person' | 'planner', turn: string | null): BacklogMessageRecord {
  return {
    id: 1,
    backlogId: 1,
    messageKey: 'm1',
    author,
    kind: 'message',
    text: 'hello',
    proposes: null,
    turn,
    attachments: [],
    createdAt: '2026-11-26T10:00:00Z',
  };
}

function turn(turnKey: string, status: TurnStatus): BacklogTurnRecord {
  return { backlogId: 1, turnKey, status, reason: '', nextTryAt: null, createdAt: '2026-11-26T10:00:00Z' };
}

describe('messageState', () => {
  it('says waiting for a message no turn took', () => {
    expect(messageState(message('person', null), [turn('t1', 'running')])).toBe('waiting');
  });

  it('says waiting for a message whose turn failed or waits for its next try', () => {
    expect(messageState(message('person', 't1'), [turn('t1', 'failed')])).toBe('waiting');
    expect(messageState(message('person', 't1'), [turn('t1', 'waiting')])).toBe('waiting');
  });

  it('says read while the turn that took the message runs', () => {
    expect(messageState(message('person', 't1'), [turn('t0', 'done'), turn('t1', 'running')])).toBe('read');
  });

  it('says answered once the answer of the turn is applied', () => {
    expect(messageState(message('person', 't1'), [turn('t1', 'applied')])).toBe('answered');
    expect(messageState(message('person', 't1'), [turn('t1', 'done')])).toBe('answered');
  });

  it('gives a planner message no state', () => {
    expect(messageState(message('planner', 't1'), [turn('t1', 'done')])).toBeUndefined();
    expect(messageView(message('planner', 't1'), [turn('t1', 'done')])).not.toHaveProperty('state');
  });

  it('puts the state on the view of a person message, waiting when no turn is given', () => {
    expect(messageView(message('person', 't1'), [turn('t1', 'done')]).state).toBe('answered');
    expect(messageView(message('person', null)).state).toBe('waiting');
  });
});

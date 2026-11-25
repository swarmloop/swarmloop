import { describe, expect, it } from 'vitest';
import type { FlowView } from '@contract/api';
import type { PlanChatEntry, PlanRevision } from '@contract/plan-chat';
import { flowView } from '../../../test/fixtures';
import { feedTimeline } from './feed-timeline';

const at = (time: string) => `2026-11-15T${time}:00.000Z`;
const entry = (key: string, time: string, role: PlanChatEntry['role'] = 'person'): PlanChatEntry => ({
  key,
  role,
  text: key,
  at: at(time),
  state: 'taken',
});
const revision = (version: number, time: string): PlanRevision => ({
  version,
  reason: 'r',
  summary: 's',
  added: [],
  changed: [],
  dropped: [],
  at: at(time),
});
const conversation = (extra: Partial<NonNullable<FlowView['conversation']>>) => ({
  composer: 'plan' as const,
  replying: false,
  entries: [],
  revisions: [],
  questions: [],
  ...extra,
});

describe('feedTimeline', () => {
  it('orders entries, revisions and questions by time, a question without a time at the update time', () => {
    const flow = flowView({
      updatedAt: at('13:00'),
      conversation: conversation({
        revisions: [revision(1, '12:30')],
        questions: [{ kind: 'question', id: 'q1', text: 'q1', answer: '', askedAt: at('12:10') }],
      }),
      items: [
        { kind: 'question', id: 'q1', label: 'q1', answer: '' },
        { kind: 'question', id: 'q2', label: 'q2', answer: '' },
      ],
    });
    const rows = feedTimeline(flow, [entry('b', '12:40'), entry('a', '12:20')]);
    expect(rows.map((row) => row.key)).toEqual(['question:q1', 'a', 'revision:1', 'b', 'question:q2']);
  });

  it('adds one line per return at its time with its words, and none for a return without words', () => {
    const flow = flowView({
      returns: [
        {
          counter: 'checks',
          count: 2,
          from: 'checks',
          to: 'implement',
          at: at('12:40'),
          words: 'Checks sent it back: lint',
        },
        {
          counter: 'review',
          count: 1,
          from: 'code-review',
          to: 'implement',
          at: at('12:20'),
          words: 'Code review sent it back: quality',
        },
        { counter: 'pipeline', count: 1, from: 'pipeline', to: 'implement', at: at('12:50') },
      ],
    });
    const rows = feedTimeline(flow, [entry('between', '12:30')]);
    expect(rows.map((row) => row.key)).toEqual(['return:review', 'between', 'return:checks']);
    expect(rows.map((row) => (row.type === 'info' ? row.sentence : null))).toEqual([
      'Code review sent it back: quality',
      null,
      'Checks sent it back: lint',
    ]);
  });

  it('puts a revision after the reply of its version on a tie, and lists revisions without entries', () => {
    const flow = flowView({ conversation: conversation({ revisions: [revision(1, '12:30')] }) });
    expect(feedTimeline(flow, [entry('reply', '12:30', 'planner')]).map((row) => row.key)).toEqual([
      'reply',
      'revision:1',
    ]);
    expect(feedTimeline(flow, []).map((row) => row.type)).toEqual(['revision']);
  });

  it('puts the problem at the update time and the streaming reply last', () => {
    const flow = flowView({
      status: 'failed',
      updatedAt: at('12:00'),
      conversation: conversation({ replying: true }),
    });
    const rows = feedTimeline(flow, [entry('late', '12:50'), entry('early', '11:00')]);
    expect(rows.map((row) => row.type)).toEqual(['message', 'problem', 'message', 'streaming']);
  });
});

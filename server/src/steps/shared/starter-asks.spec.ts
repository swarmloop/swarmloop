import type { PlanChatEntry } from '../../contract/plan-chat';
import { asksForStarter } from './starter-asks';

function entry(key: string, at: string, extra: Partial<PlanChatEntry>): PlanChatEntry {
  return { key, role: 'planner', text: key, at, state: 'pending', ...extra };
}

describe('asksForStarter', () => {
  it('gives the pending escalations of implement and implement-improve, oldest first', () => {
    const entries = [
      entry('b', '2026-11-19T10:02:00Z', { kind: 'escalation', from: 'implement-improve' }),
      entry('a', '2026-11-19T10:01:00Z', { kind: 'escalation', from: 'implement' }),
    ];
    expect(asksForStarter({ entries }).map((item) => item.key)).toEqual(['a', 'b']);
  });

  it('leaves out an escalation an answer of the asking step already closed', () => {
    const entries = [
      entry('ask', '2026-11-19T10:01:00Z', { kind: 'escalation', from: 'implement' }),
      entry('reply', '2026-11-19T10:02:00Z', { kind: 'answer', from: 'implement', state: 'taken' }),
      entry('other', '2026-11-19T10:03:00Z', { kind: 'escalation', from: 'implement-improve' }),
    ];
    expect(asksForStarter({ entries }).map((item) => item.key)).toEqual(['other']);
  });

  it('leaves out entries that are not a pending escalation of an implement step', () => {
    const entries = [
      entry('research', '2026-11-19T10:01:00Z', { kind: 'escalation', from: 'research' }),
      entry('question', '2026-11-19T10:02:00Z', { kind: 'question', from: 'implement' }),
      entry('taken', '2026-11-19T10:03:00Z', { kind: 'escalation', from: 'implement', state: 'taken' }),
      entry('message', '2026-11-19T10:04:00Z', { role: 'person' }),
    ];
    expect(asksForStarter({ entries })).toEqual([]);
  });
});

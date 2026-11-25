import { replyEscalation } from './reply-escalation';

describe('replyEscalation', () => {
  it('reads nothing from a missing or blank escalate', () => {
    expect(replyEscalation(undefined, { key: 'message-1' }, '2026-01-01T00:00:00.000Z')).toBeNull();
    expect(replyEscalation('  \n ', { key: 'message-1' }, '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  it('makes the pending escalation of the asked key with the trimmed text', () => {
    expect(replyEscalation(' Which one? ', { key: 'message-1' }, '2026-01-01T00:00:00.000Z')).toEqual({
      key: 'escalate-message-1',
      role: 'planner',
      kind: 'escalation',
      text: 'Which one?',
      at: '2026-01-01T00:00:00.000Z',
      state: 'pending',
    });
  });

  it('names the step that asked only when there is one', () => {
    const entry = replyEscalation('Which one?', { key: 'q-1', from: 'implement' }, '2026-01-01T00:00:00.000Z');
    expect(entry?.from).toBe('implement');
  });
});

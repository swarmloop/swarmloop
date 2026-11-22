import { describe, expect, it } from 'vitest';
import type { PlanChatEntry } from '@contract/plan-chat';
import { talkSentence, type AgentTalk } from './conversation-words';
import { feedEntries } from './talk-entries';

const at = '2026-11-15T07:11:43.444Z';
const planner = (key: string, text: string, extra: Partial<PlanChatEntry> = {}): PlanChatEntry => ({
  key,
  role: 'planner',
  text,
  at,
  state: 'taken',
  ...extra,
});

describe('feedEntries', () => {
  it('turns a step question and the planner answer to it into one line of talk', () => {
    const entries = [
      planner('ask-implement-a1', 'Which pagination to keep?', { kind: 'question', from: 'implement' }),
      planner('answer-ask-implement-a1', 'Cursor, as in the brief.', { kind: 'answer', from: 'implement' }),
    ];

    const feed = feedEntries(entries);

    expect(feed).toHaveLength(1);
    expect(talkSentence(feed[0] as AgentTalk)).toBe(
      'Implement asked the planner: Which pagination to keep; the answer was: Cursor, as in the brief.',
    );
  });

  it('names a reviewer and an improve step in words', () => {
    const feed = feedEntries([
      planner('ask-code-review-quality-a1', 'Is the helper public?', { kind: 'question', from: 'code-review-quality' }),
      planner('ask-implement-improve-a2', 'Keep the flag?', { kind: 'question', from: 'implement-improve' }),
    ]) as AgentTalk[];

    expect(feed.map((talk) => talk.who)).toEqual(['The quality reviewer', 'Implement improve']);
  });

  it('shows an escalation with its question as one line that says the planner passed it on', () => {
    const feed = feedEntries([
      planner('ask-implement-a1', 'Which store?', { kind: 'question', from: 'implement' }),
      planner('escalate-ask-implement-a1', 'Pick the store for the logs.', { kind: 'escalation', from: 'implement' }),
    ]);

    expect(feed).toHaveLength(1);
    expect(talkSentence(feed[0] as AgentTalk)).toBe(
      'Implement asked the planner: Which store; the planner passed it on to you.',
    );
  });

  it('carries the key of the escalation on a joined line and on a lone escalation, and none without one', () => {
    const feed = feedEntries([
      planner('ask-implement-a1', 'Which store?', { kind: 'question', from: 'implement' }),
      planner('escalate-ask-implement-a1', 'Pick the store.', { kind: 'escalation', from: 'implement' }),
      planner('escalate-lone', 'Pick the format.', { kind: 'escalation', from: 'implement' }),
      planner('ask-implement-a2', 'Which name?', { kind: 'question', from: 'implement' }),
    ]) as AgentTalk[];

    expect(feed.map((talk) => talk.escalation)).toEqual(['escalate-ask-implement-a1', 'escalate-lone', undefined]);
  });

  it('says the parent planner on a subtask page', () => {
    const [talk] = feedEntries(
      [planner('ask-implement-a1', 'Which store?', { kind: 'question', from: 'implement' })],
      'PROJ-1',
    );

    expect(talkSentence(talk as AgentTalk)).toBe("Implement asked the parent's planner: Which store.");
  });

  it('leaves the messages of a person and the replies of the planner as they are', () => {
    const entries: PlanChatEntry[] = [
      { key: 'message-1', role: 'person', author: 'ana', text: 'Add logging', at, state: 'taken' },
      planner('reply-1', 'Done.', { version: 2 }),
    ];

    expect(feedEntries(entries)).toEqual(entries);
  });
});

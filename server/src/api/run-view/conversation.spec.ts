import type { DocumentEntity } from '../../history/entities';
import type { FlowItem } from '../../contract/api';
import type { PlanChatEntry } from '../../contract/plan-chat';
import type { RunState } from '../../contract/run-state';
import { conversationView } from './conversation';

const entry = (key: string, at: string, role: PlanChatEntry['role'] = 'person'): PlanChatEntry => ({
  key,
  role,
  text: key,
  at,
  state: 'taken',
});

const view = (
  place: { step: string; split?: boolean },
  state: RunState,
  extra: {
    documents?: DocumentEntity[];
    parentKey?: string;
    items?: FlowItem[];
    entries?: PlanChatEntry[];
    replying?: boolean;
  } = {},
) =>
  conversationView({
    run: { currentStep: place.step, workspace: null },
    split: place.split ?? false,
    state,
    parentKey: extra.parentKey,
    items: extra.items ?? [],
    log: { entries: extra.entries ?? [], revisions: [] },
    replying: extra.replying ?? false,
    documents: extra.documents,
  });

describe('conversationView', () => {
  it('maps the place of a run to the mode of the message box', () => {
    expect(view({ step: 'plan' }, 'running').composer).toBe('plan');
    expect(view({ step: 'implement' }, 'running').composer).toBe('amend');
    expect(view({ step: 'implement', split: true }, 'running').composer).toBe('add-tasks');
    expect(view({ step: 'done' }, 'done').composer).toBe('reopen');
    expect(view({ step: 'implement' }, 'stopped').composer).toBe('reopen');
    expect(view({ step: 'done' }, 'merged').composer).toBe('follow-up');
    expect(view({ step: 'done' }, 'closed').composer).toBe('follow-up');
  });

  it('shows a message that answers open questions as a message to the plan', () => {
    const items: FlowItem[] = [{ kind: 'question', id: 'q1', label: 'Which limit?', answer: '' }];
    const shown = view({ step: 'research' }, 'waiting', { items });
    expect(shown.composer).toBe('plan');
    expect(shown.questions).toEqual([{ kind: 'question', id: 'q1', text: 'Which limit?', answer: '' }]);
  });

  it('is read only on a subtask and names the parent', () => {
    const shown = view({ step: 'implement' }, 'running', { parentKey: 'epic-1' });
    expect(shown.composer).toBe('read-only');
    expect(shown.parentKey).toBe('epic-1');
    expect(view({ step: 'implement' }, 'running')).not.toHaveProperty('parentKey');
  });

  it('lists the entries in the order of their time and says when the planner replies', () => {
    const entries = [
      entry('second', '2026-01-01T00:00:02.000Z', 'planner'),
      entry('first', '2026-01-01T00:00:01.000Z'),
    ];
    const shown = view({ step: 'plan' }, 'running', { entries, replying: true });
    expect(shown.entries.map((item) => item.key)).toEqual(['first', 'second']);
    expect(shown.replying).toBe(true);
    expect(view({ step: 'plan' }, 'running').replying).toBe(false);
  });

  it('gives each question the time it was asked', () => {
    const parts = { decide: 'd', sides: [], full: 'f', askedAt: '2026-01-01T12:25:00.000Z' };
    const documents = [
      { kind: 'questions', body: '["Which limit?"]', createdAt: '2026-01-01T10:00:00.000Z' },
      { kind: 'questions', body: '["Which limit?","Other"]', createdAt: '2026-01-01T11:00:00.000Z' },
      { kind: 'plan', body: 'Which limit?', createdAt: '2026-01-01T13:00:00.000Z' },
    ] as DocumentEntity[];
    const items: FlowItem[] = [
      { kind: 'question', id: 'q1', label: 'Timed', answer: '', parts },
      { kind: 'question', id: 'Which limit?\nmore', label: 'Which limit?', answer: '' },
      { kind: 'question', id: 'Unknown', label: 'Unknown', answer: '' },
    ];
    const shown = view({ step: 'research' }, 'waiting', { items, documents });
    expect(shown.questions.map((question) => question.askedAt)).toEqual([
      '2026-01-01T12:25:00.000Z',
      '2026-01-01T11:00:00.000Z',
      undefined,
    ]);
    expect(shown.questions[2]).not.toHaveProperty('askedAt');
  });
});

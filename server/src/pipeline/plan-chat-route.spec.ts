import type { RunState } from '../contract/run-state';
import { messageTurn, type MessageTurn } from './plan-chat-route';

const turn = (
  place: { step: string; split?: boolean; workspace?: string | null },
  state: RunState,
  extra: { parentKey?: string; openItems?: number } = {},
): MessageTurn =>
  messageTurn(
    { currentStep: place.step, workspace: place.workspace ?? null },
    { state, openItems: 0, split: place.split ?? false, ...extra },
  );

describe('messageTurn', () => {
  it('sends a message of a subtask to its parent, whatever else it is', () => {
    expect(turn({ step: 'implement' }, 'running', { parentKey: 'p-1', openItems: 1 })).toBe('subtask');
  });

  it('refuses a merged, closed or removed run with a follow-up', () => {
    expect(turn({ step: 'done' }, 'merged')).toBe('follow-up');
    expect(turn({ step: 'done' }, 'closed')).toBe('follow-up');
    expect(turn({ step: 'done', workspace: 'removed' }, 'done')).toBe('follow-up');
  });

  it('takes a message as the answer while questions wait for the person', () => {
    expect(turn({ step: 'research' }, 'waiting', { openItems: 2 })).toBe('answer');
    expect(turn({ step: 'implement', split: true }, 'waiting', { openItems: 1 })).toBe('answer');
  });

  it('gives planning from requirements to plan-improve, also for a run stopped, failed or blocked there', () => {
    for (const step of ['requirements', 'prepare', 'research', 'plan', 'plan-improve']) {
      expect(turn({ step }, 'running')).toBe('planning');
    }
    expect(turn({ step: 'plan' }, 'stopped')).toBe('planning');
    expect(turn({ step: 'research' }, 'failed')).toBe('planning');
    expect(turn({ step: 'plan-improve' }, 'blocked')).toBe('planning');
  });

  it('amends the plan of a run that does not split once implement started', () => {
    for (const step of ['implement', 'checks', 'code-review', 'pipeline']) {
      expect(turn({ step }, 'running')).toBe('amend');
    }
  });

  it('adds tasks to a split run once implement started', () => {
    expect(turn({ step: 'implement', split: true }, 'running')).toBe('add-tasks');
  });

  it('reopens a done, stopped, failed or blocked run after implement started', () => {
    expect(turn({ step: 'done' }, 'done')).toBe('reopen');
    expect(turn({ step: 'implement' }, 'stopped')).toBe('reopen');
    expect(turn({ step: 'checks', split: true }, 'failed')).toBe('reopen');
    expect(turn({ step: 'code-review' }, 'blocked')).toBe('reopen');
  });
});

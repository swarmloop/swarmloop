import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { writeRunState } from '../../history/run-state';
import { betweenPasses, takesMain } from './epic-between-passes';

function epic(change: Parameters<typeof writeRunState>[1]): RunEntity {
  const run = { key: 'f1', split: true, currentStep: 'implement', stateReason: null, mergeOutcome: null } as RunEntity;
  writeRunState(run, change);
  return run;
}

const reason = (code: string) => ({ code, message: 'why' });

describe('betweenPasses', () => {
  it.each([
    ['waits for running subtasks', { status: 'waiting', currentStep: 'implement', reason: reason('SUBTASKS_RUNNING') }],
    ['waits for a waiting subtask', { status: 'waiting', currentStep: 'implement', reason: reason('SUBTASK_WAITING') }],
    ['is blocked by a subtask', { status: 'blocked', currentStep: 'implement', reason: reason('SUBTASK_BLOCKED') }],
  ])('is true for an epic that %s', (_name, change) => {
    expect(betweenPasses(epic(change))).toBe(true);
  });

  it.each([
    ['runs', { status: 'running', currentStep: 'implement' }],
    ['is blocked for another reason', { status: 'blocked', currentStep: 'implement', reason: reason('CHECK_FAILED') }],
    ['waits at another step', { status: 'waiting', currentStep: 'checks', reason: reason('SUBTASKS_RUNNING') }],
  ])('is false for an epic that %s', (_name, change) => {
    expect(betweenPasses(epic(change))).toBe(false);
  });
});

describe('takesMain', () => {
  const asksPlanner = { status: 'waiting', currentStep: 'implement', reason: reason('ASKS_PLANNER') } as const;
  const waitsForMain = { status: 'waiting', currentStep: 'implement', reason: reason('WAITS_FOR_MAIN') } as const;
  const needsAnswers = { status: 'waiting', currentStep: 'implement', facts: { needsAnswers: true } } as const;

  /** The documents of the epic by kind: the latest body of each. */
  const documentsOf = (stored: Record<string, string> = {}) =>
    ({
      latestBody: (_key: string, kind: string) => Promise.resolve(stored[kind] ?? null),
      latestDocuments: (_ids: number[], kinds: string[]) =>
        Promise.resolve(kinds.filter((kind) => kind in stored).map((kind) => ({ kind, body: stored[kind] }))),
      latestDocument: () => Promise.resolve(null),
      latestCreatedAt: () => Promise.resolve(null),
      revisionsOfKind: () => Promise.resolve([]),
    }) as unknown as DocumentRepository;
  const runs = { findSubtask: () => Promise.resolve(null) };
  const takes = (stored: Record<string, string>, change: Parameters<typeof epic>[0], base: Partial<RunEntity> = {}) =>
    takesMain(documentsOf(stored), runs, { ...epic(change), ...base });
  const open = JSON.stringify([{ id: 'a', status: 'waiting' }]);
  const settledList = JSON.stringify([{ id: 'a', status: 'merged' }]);

  it.each([
    ['waits for running subtasks', { status: 'waiting', currentStep: 'implement', reason: reason('SUBTASKS_RUNNING') }],
    ['is blocked by a subtask', { status: 'blocked', currentStep: 'implement', reason: reason('SUBTASK_BLOCKED') }],
    ['waits for the planner on a question', asksPlanner],
    ['waits for answers', needsAnswers],
    ['waits for a green main', waitsForMain],
  ])('is true for an epic that %s', async (_name, change) => {
    expect(await takes({ subtasks: open }, change)).toBe(true);
  });

  it.each([
    ['runs', { status: 'running', currentStep: 'implement' }],
    ['waits for the planner at another step', { ...asksPlanner, currentStep: 'checks' }],
    ['waits for a green main at another step', { ...waitsForMain, currentStep: 'checks' }],
  ])('is false for an epic that %s', async (_name, change) => {
    expect(await takes({ subtasks: open }, change)).toBe(false);
  });

  it('is false for a run that is not split', async () => {
    expect(await takes({ subtasks: open }, asksPlanner, { split: false })).toBe(false);
  });

  it.each([
    ['a parked conflict of its own branch', { rebase_conflict: 'pending\n', subtasks: open }],
    ['a defect return it fixes with every part settled', { return: 'fix it', subtasks: settledList }],
    ['a resolution round', { epic_round: 'open\n', return: 'fix it', subtasks: open }],
  ])('is false for an epic that waits on a question of its own agent: %s', async (_name, stored) => {
    expect(await takes(stored, asksPlanner)).toBe(false);
  });

  it('is false for an epic that waits for a green main on a parked conflict of its own agent', async () => {
    expect(await takes({ rebase_conflict: 'pending\n', subtasks: open }, waitsForMain)).toBe(false);
  });

  it('is true for an epic that waits on the question of a gap with every part settled and return notes', async () => {
    const stored = { return: 'fix it', subtasks: settledList, subtask_questions: '- Which type are the ids?\n' };
    expect(await takes(stored, asksPlanner)).toBe(true);
  });

  it('leaves betweenPasses false for a question, so a question never resumes the epic', () => {
    expect(betweenPasses(epic(asksPlanner))).toBe(false);
    expect(betweenPasses(epic(needsAnswers))).toBe(false);
  });
});

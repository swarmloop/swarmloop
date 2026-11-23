import type { RunEntity } from '../../history/entities';
import { writeRunState } from '../../history/run-state';
import { betweenPasses } from './epic-between-passes';

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

import type { RunEntity } from '../../history/entities';
import { writeRunState, type RunStateChange } from '../../history/run-state';
import type { Subtask } from '../../contract/subtask';
import { disagrees, mergedOf, moveNote, taskStatusOf } from './subtask-status';

const task = (status: Subtask['status']): Subtask => ({
  id: 'a',
  title: 'Task a',
  description: 'Do a.',
  depends: [],
  files: [],
  proof: 'a.spec.ts',
  status,
});

const run = (change: RunStateChange): RunEntity => {
  const entity = { status: 'waiting', currentStep: 'requirements', stateReason: null, mergeOutcome: null } as RunEntity;
  writeRunState(entity, change);
  return entity;
};

const merged = { merged: { demo: { sha: 'abc', by: null, at: '2026-11-19T00:07:10.000Z', url: null } } };

describe('the status a run gives its task', () => {
  it('is merged for a done run whose merge is recorded, with the merge commit of each repository', () => {
    const child = run({ status: 'done', currentStep: 'done', merge: merged });

    expect(taskStatusOf(task('green'), child)).toBe('merged');
    expect(mergedOf(child)).toEqual({ demo: 'abc' });
  });

  it('is green for a done run with no merge outcome or a closed one', () => {
    const closed = { closed: { repo: 'demo', by: null, at: '2026-11-19T00:07:10.000Z' } };

    expect(taskStatusOf(task('running'), run({ status: 'done', currentStep: 'done' }))).toBe('green');
    expect(taskStatusOf(task('running'), run({ status: 'done', currentStep: 'done', merge: closed }))).toBe('green');
    expect(mergedOf(run({ status: 'done', currentStep: 'done', merge: closed }))).toBeUndefined();
  });

  it('is blocked for a blocked or failed run, waiting at requirements, and running otherwise', () => {
    expect(taskStatusOf(task('running'), run({ status: 'blocked', currentStep: 'plan' }))).toBe('blocked');
    expect(taskStatusOf(task('running'), run({ status: 'failed', currentStep: 'plan' }))).toBe('blocked');
    expect(taskStatusOf(task('waiting'), run({ status: 'waiting', currentStep: 'requirements' }))).toBe('waiting');
    expect(taskStatusOf(task('waiting'), run({ status: 'running', currentStep: 'research' }))).toBe('running');
  });

  it('is running for a blocked task whose move is queued or running, and blocked once the move failed', () => {
    const checks = run({
      status: 'blocked',
      currentStep: 'checks',
      reason: { code: 'CHECK_FAILED', message: 'a check failed' },
    });

    expect(taskStatusOf(task('blocked'), checks, { kind: 'moving' })).toBe('running');
    expect(taskStatusOf(task('running'), checks, { kind: 'failed', reason: 'push refused' })).toBe('blocked');
    expect(taskStatusOf(task('blocked'), checks)).toBe('blocked');
  });

  it('is merged for a merged run whatever its move says', () => {
    const child = run({ status: 'done', currentStep: 'done', merge: merged });

    expect(taskStatusOf(task('green'), child, { kind: 'moving' })).toBe('merged');
    expect(taskStatusOf(task('green'), child, { kind: 'failed', reason: 'no' })).toBe('merged');
  });

  it('says in words what the move is', () => {
    expect(moveNote({ kind: 'moving' })).toBe("moving onto the epic's new tip");
    expect(moveNote({ kind: 'failed', reason: 'push refused' })).toBe(
      "its move onto the epic's new tip failed: push refused",
    );
  });

  it('disagrees with a running task whose blocked run has a failed move', () => {
    const child = run({ status: 'blocked', currentStep: 'checks' });

    expect(disagrees(task('blocked'), child)).toBe(false);
    expect(disagrees(task('running'), child, { kind: 'failed', reason: 'no' })).toBe(true);
  });

  it('disagrees with a running task that still says it is moving once its move has ended', () => {
    const child = run({ status: 'running', currentStep: 'implement' });
    const moving = { ...task('running'), note: moveNote({ kind: 'moving' }) };

    expect(disagrees(moving, child, { kind: 'moving' })).toBe(false);
    expect(disagrees(moving, child)).toBe(true);
  });

  it('disagrees with a task that is not settled and has another status, and never with a settled one', () => {
    const child = run({ status: 'done', currentStep: 'done', merge: merged });

    expect(disagrees(task('green'), child)).toBe(true);
    expect(disagrees(task('merged'), child)).toBe(false);
    expect(disagrees(task('skipped'), child)).toBe(false);
  });
});

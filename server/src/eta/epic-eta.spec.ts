import type { SubtaskStatus } from '../contract/run-state';
import type { EtaTable, TaskInput } from './eta.types';
import { emptyTable, liveRun, MIN, NOW } from './eta.spec-helpers';
import { epicEta } from './epic-eta';
import { seedFor } from './seed';

const table = (): EtaTable => ({
  ...emptyTable(),
  epic: { steps: { 'implement-improve': 7 * MIN }, whole: null },
  subtask: { steps: {}, whole: 10 * MIN },
});
const parent = liveRun({ kind: 'epic', currentStep: 'implement' });
const task = (id: string, depends: string[] = [], status: SubtaskStatus = 'waiting'): TaskInput => ({
  id,
  status,
  depends,
});
const leftOf = (tasks: TaskInput[], parallel = 3, t = table()) => epicEta(parent, tasks, t, parallel, NOW)?.leftMs;

describe('epicEta', () => {
  it('gives the longest chain of a graph of 6 tasks', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['b']), task('d'), task('e', ['d']), task('f', ['a', 'e'])];
    expect(leftOf(tasks, 6)).toBe(3 * 10 * MIN + 7 * MIN);
  });

  it('gives about four task lengths for 12 independent tasks with parallel 3', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task(`t${i}`));
    expect(leftOf(tasks, 3)).toBe(4 * 10 * MIN + 7 * MIN);
  });

  it('changes when a task merges', () => {
    const before = leftOf([task('a'), task('b', ['a'])]);
    const after = leftOf([task('a', [], 'merged'), task('b', ['a'])]);
    expect(before! - after!).toBe(10 * MIN);
  });

  it('counts a green task as nothing and a started task by its own estimate', () => {
    const started: TaskInput = {
      ...task('a', [], 'running'),
      run: liveRun({ kind: 'subtask', currentStep: 'implement' }),
    };
    expect(leftOf([started, task('g', [], 'green')])).toBe(seedFor('implement') + 7 * MIN);
  });

  it('waits for you when a task is blocked or its run waits for a person', () => {
    expect(epicEta(parent, [task('a'), task('b', [], 'blocked')], table(), 3, NOW)).toBeNull();
    const stuck: TaskInput = { ...task('a', [], 'running'), run: liveRun({ kind: 'subtask', state: 'blocked' }) };
    expect(epicEta(parent, [stuck], table(), 3, NOW)).toBeNull();
  });

  it('reads the parent alone when no task is left, and none when it waits or ended', () => {
    expect(leftOf([task('a', [], 'merged'), task('b', [], 'skipped')])).toBe(seedFor('implement'));
    expect(epicEta(liveRun({ kind: 'epic', state: 'blocked' }), [task('a')], table(), 3, NOW)).toBeNull();
    expect(epicEta(liveRun({ kind: 'epic', state: 'done' }), [task('a')], table(), 3, NOW)).toBeUndefined();
  });

  it('adds nothing after the last step and survives a cycle and unknown ids', () => {
    const last = liveRun({ kind: 'epic', currentStep: 'done' });
    const tasks = [task('a', ['b', 'zzz']), task('b', ['a'])];
    expect(epicEta(last, tasks, table(), 3, NOW)?.leftMs).toBe(20 * MIN);
  });
});

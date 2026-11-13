import type { RunState } from './run-state';
import { parseSubtasks, readyTasks, shownTaskState, splitLine, statusLine, waitNote, type Subtask } from './subtask';

describe('parseSubtasks', () => {
  it('parseSubtasks reads depends and status', () => {
    const old = JSON.stringify([{ id: 'a', title: 'A', description: '', files: ['a.ts'], proof: 'p' }]);
    expect(parseSubtasks(old)).toEqual([
      { id: 'a', title: 'A', description: '', files: ['a.ts'], proof: 'p', depends: [], status: 'waiting' },
    ]);
    expect(parseSubtasks(JSON.stringify([{ id: 'b', depends: ['a'] }]))[0]?.depends).toEqual(['a']);
    expect(parseSubtasks('not json')).toEqual([]);
  });
});

const task = (id: string, status: Subtask['status'], depends: string[] = []): Subtask => ({
  id,
  title: id,
  description: '',
  depends,
  files: [],
  proof: '',
  status,
});

describe('readyTasks', () => {
  it('lists the waiting tasks whose dependencies are merged or skipped', () => {
    const tasks = [
      task('a', 'merged'),
      task('b', 'skipped'),
      task('c', 'waiting', ['a', 'b']),
      task('d', 'waiting', ['c']),
    ];
    expect(readyTasks(tasks, 3).map((item) => item.id)).toEqual(['c']);
  });

  it('does not start a task whose dependency is only green', () => {
    expect(readyTasks([task('a', 'green'), task('b', 'waiting', ['a'])], 3)).toEqual([]);
  });

  it('stops at the free slots', () => {
    const tasks = [task('a', 'running'), task('b', 'waiting'), task('c', 'waiting'), task('d', 'waiting')];
    expect(readyTasks(tasks, 3).map((item) => item.id)).toEqual(['b', 'c']);
    expect(readyTasks(tasks, 1)).toEqual([]);
  });
});

describe('a blocked task', () => {
  it('holds back its dependents at one and two levels, and an independent task stays ready', () => {
    const tasks = [
      task('a', 'blocked'),
      task('b', 'waiting', ['a']),
      task('c', 'waiting', ['b']),
      task('d', 'waiting'),
    ];
    expect(readyTasks(tasks, 3).map((item) => item.id)).toEqual(['d']);
  });

  it('does not loop on a dependency cycle', () => {
    const tasks = [task('a', 'waiting', ['b']), task('b', 'waiting', ['a'])];
    expect(readyTasks(tasks, 3)).toEqual([]);
    expect(waitNote(tasks[0], tasks)).toBe('waiting for b');
  });
});

describe('waitNote', () => {
  it('names the blocked task behind a chain', () => {
    const tasks = [task('a', 'blocked'), task('b', 'waiting', ['a']), task('c', 'waiting', ['b'])];
    expect(waitNote(tasks[1], tasks)).toBe('waiting for a, which is blocked');
    expect(waitNote(tasks[2], tasks)).toBe('waiting for a, which is blocked');
  });

  it('names the tasks that are not settled and never a merged one', () => {
    const tasks = [task('a', 'merged'), task('b', 'running'), task('c', 'waiting', ['a', 'b'])];
    expect(waitNote(tasks[2], tasks)).toBe('waiting for b');
  });

  it('says a task that waits only for a slot is waiting for a free slot', () => {
    const tasks = [task('a', 'running'), task('b', 'running'), task('c', 'waiting', ['d']), task('d', 'merged')];
    expect(waitNote(tasks[2], tasks)).toBe('waiting for a free slot: 2 of SUBTASKS_PARALLEL running');
  });
});

describe('statusLine', () => {
  it('counts the merged tasks of all and the others by status', () => {
    const tasks = [
      ...['m1', 'm2', 'm3', 'm4'].map((id) => task(id, 'merged')),
      task('r1', 'running'),
      task('r2', 'running'),
      task('w', 'waiting'),
    ];
    expect(statusLine(tasks)).toBe('4/7 merged · 2 running · 1 waiting');
  });
});

describe('splitLine', () => {
  it('counts every task, the merged ones and the running ones', () => {
    const tasks = [task('a', 'merged'), task('b', 'merged'), task('c', 'running'), task('d', 'waiting')];
    expect(splitLine(tasks)).toBe('Split: 4 tasks · 2 merged · 1 running');
  });

  it('leaves the running count out when no task runs', () => {
    expect(splitLine([task('a', 'merged'), task('b', 'green')])).toBe('Split: 2 tasks · 1 merged');
  });
});

describe('shownTaskState', () => {
  const run = (state: RunState, currentStep = 'implement') => ({ state, currentStep });

  it('reads the own run of the task, not the stored status', () => {
    expect(shownTaskState(task('a', 'blocked'), run('running'))).toBe('running');
    expect(shownTaskState(task('a', 'running'), run('failed'))).toBe('blocked');
    expect(shownTaskState(task('a', 'running'), run('done'))).toBe('green');
    expect(shownTaskState(task('a', 'running'), run('recovering'))).toBe('running');
    expect(shownTaskState(task('a', 'blocked'), run('waiting', 'requirements'))).toBe('waiting');
  });

  it('keeps what the parent closed, and waits without a run', () => {
    expect(shownTaskState(task('a', 'merged'), run('running'))).toBe('merged');
    expect(shownTaskState(task('a', 'skipped'), run('failed'))).toBe('skipped');
    expect(shownTaskState(task('a', 'running'))).toBe('waiting');
  });
});

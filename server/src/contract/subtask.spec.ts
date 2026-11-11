import { parseSubtasks, readyTasks, statusLine, type Subtask } from './subtask';

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

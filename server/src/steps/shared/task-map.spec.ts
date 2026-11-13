import type { Subtask } from '../../contract/subtask';
import { renderTaskMap, taskMap } from './task-map';

function task(id: string, extra: Partial<Subtask> = {}): Subtask {
  return {
    id,
    title: `Title ${id}`,
    description: '',
    depends: [],
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    status: 'waiting',
    ...extra,
  };
}

describe('task map', () => {
  it('lists the siblings with id, title, files and shown state, and leaves the task out', () => {
    const tasks = [task('a'), task('b'), task('c')];

    const map = taskMap(tasks, tasks[0], {}, {});

    expect(map.siblings).toEqual([
      { id: 'b', title: 'Title b', files: ['b.ts'], state: 'waiting' },
      { id: 'c', title: 'Title c', files: ['c.ts'], state: 'waiting' },
    ]);
  });

  it("shows a run's own state over the stored status", () => {
    const tasks = [task('a'), task('b', { status: 'running' }), task('c', { status: 'running' })];
    const runs = {
      b: { state: 'blocked' as const, currentStep: 'implement' },
      c: { state: 'running' as const, currentStep: 'implement' },
    };

    const states = taskMap(tasks, tasks[0], runs, {}).siblings.map((item) => item.state);

    expect(states).toEqual(['blocked', 'running']);
  });

  it('keeps the stored status of a task the parent closed', () => {
    const tasks = [task('a'), task('b', { status: 'merged' }), task('c', { status: 'skipped' })];
    const runs = { b: { state: 'running' as const, currentStep: 'implement' } };

    const states = taskMap(tasks, tasks[0], runs, {}).siblings.map((item) => item.state);

    expect(states).toEqual(['merged', 'skipped']);
  });

  it('lists the files a merged dependency changed, not the files its plan named', () => {
    const tasks = [task('a', { depends: ['b'] }), task('b', { status: 'merged', files: ['b.ts'] })];

    const map = taskMap(tasks, tasks[0], {}, { b: 'Made b.' }, { b: ['b.ts', 'shared/helper.ts'] });

    expect(map.merged).toEqual([{ id: 'b', files: ['b.ts', 'shared/helper.ts'], summary: 'Made b.' }]);
    expect(map.siblings[0]?.files).toEqual(['b.ts']);
  });

  it('gives a merged dependency its summary and files, and no one else', () => {
    const tasks = [
      task('a', { depends: ['b', 'c'] }),
      task('b', { status: 'merged', files: ['b.ts', 'b.spec.ts'] }),
      task('c'),
      task('d', { status: 'merged' }),
    ];

    const map = taskMap(tasks, tasks[0], {}, { b: 'Made b.', c: 'Made c.', d: 'Made d.' });

    expect(map.merged).toEqual([{ id: 'b', files: ['b.ts', 'b.spec.ts'], summary: 'Made b.' }]);
    const text = renderTaskMap(map);
    expect(text).toContain('- b (merged): Title b - files: b.ts, b.spec.ts');
    expect(text).toContain('Made b.');
    expect(text).not.toContain('Made c.');
    expect(text).not.toContain('Made d.');
  });

  it('renders nothing for a task with no siblings', () => {
    const tasks = [task('a')];

    expect(renderTaskMap(taskMap(tasks, tasks[0], {}, {}))).toBe('');
  });
});

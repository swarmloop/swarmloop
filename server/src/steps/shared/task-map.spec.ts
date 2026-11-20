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

  describe('with the owners of the contract items', () => {
    const items = [
      { id: 'tool', owner: 'b', text: 'the tool takes a path' },
      { id: 'cache', owner: 'c', text: 'the cache is keyed by host' },
      { id: 'old', owner: '', text: 'a rule written before owners' },
    ];

    it('names the items each sibling owns and counts one as delivered once its owner merged', () => {
      const tasks = [task('a'), task('b', { status: 'merged' }), task('c')];

      const map = taskMap(tasks, tasks[0], {}, {}, {}, items);

      expect(map.siblings.map((item) => item.items)).toEqual([
        [{ id: 'tool', status: 'delivered' }],
        [{ id: 'cache', status: 'pending' }],
      ]);
      const text = renderTaskMap(map);
      expect(text).toContain('- b (merged): Title b - files: b.ts - owns: tool (delivered)');
      expect(text).toContain('- c (waiting): Title c - files: c.ts - owns: cache (pending)');
    });

    it('gives a merged dependency the items it delivered', () => {
      const tasks = [task('a', { depends: ['b'] }), task('b', { status: 'merged' })];

      const text = renderTaskMap(taskMap(tasks, tasks[0], {}, { b: 'Made b.' }, {}, items));

      expect(text).toContain('Made b.\nContract items it delivered:\n- tool: the tool takes a path');
    });

    it('renders a contract with no owners as before', () => {
      const tasks = [task('a'), task('b')];

      const text = renderTaskMap(taskMap(tasks, tasks[0], {}, {}, {}, [items[2]]));

      expect(text).toBe('Task map, the other tasks of the parent run:\n- b (waiting): Title b - files: b.ts');
    });
  });
});

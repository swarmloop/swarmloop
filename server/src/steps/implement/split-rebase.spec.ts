import type { Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import type { RebaseEvent, SubtaskOps } from '../shared/subtask-ops';
import { SplitRebase } from './split-rebase';

const parent = { key: 'f1', startedBy: 'ada', codeHost: 'gitlab' } as RunEntity;
const task = (id: string, files: string[] = []) => ({ id, status: 'waiting', files, note: '' }) as unknown as Subtask;

/** Fakes of the part runs: which keep their wait, which conflict, and the moves they were sent. */
function setup(options: { keeps: string[]; conflicting: string[] }) {
  const moved: { key: string; event?: RebaseEvent }[] = [];
  const subtasks = {
    find: (_parent: RunEntity, id: string) => Promise.resolve({ key: id } as RunEntity),
    keepsWait: (run: RunEntity) => Promise.resolve(options.keeps.includes(run.key)),
    mergeRequests: (run: RunEntity) =>
      Promise.resolve(options.conflicting.includes(run.key) ? [{ repo: 'web', project: 'acme/web', iid: 1 }] : []),
    conflictFiles: () => Promise.resolve([]),
    rebase: (run: RunEntity, event?: RebaseEvent) => {
      moved.push({ key: run.key, event });
      return Promise.resolve(!options.keeps.includes(run.key));
    },
  } as unknown as SubtaskOps;
  const hosts = {
    forRun: () => Promise.resolve({ byName: () => ({ readMergeRequest: () => Promise.resolve({ conflicts: true }) }) }),
  } as unknown as CodeHostRegistry;
  return { moved, rebase: new SplitRebase(subtasks, hosts) };
}

describe('SplitRebase.afterMerge', () => {
  it('moves a task that waits on a person or a sibling, notes why, and leaves it as it was', async () => {
    const { moved, rebase } = setup({ keeps: ['b'], conflicting: [] });
    const tasks = [task('a'), task('b')];
    const next = await rebase.afterMerge(parent, tasks, tasks[0], 'web@tip');
    expect(moved).toEqual([{ key: 'b', event: { tip: 'web@tip', note: 'rebased onto the epic after a merged' } }]);
    expect(next[1]).toBe(tasks[1]);
  });

  it('moves no task that waits on nothing and does not conflict', async () => {
    const { moved, rebase } = setup({ keeps: [], conflicting: [] });
    const tasks = [task('a'), task('b')];
    await rebase.afterMerge(parent, tasks, tasks[0], 'web@tip');
    expect(moved).toEqual([]);
  });

  it('moves a task that conflicts and marks it running', async () => {
    const { moved, rebase } = setup({ keeps: [], conflicting: ['b'] });
    const tasks = [task('a'), task('b')];
    const next = await rebase.afterMerge(parent, tasks, tasks[0], 'web@tip');
    expect(moved.map((sent) => sent.key)).toEqual(['b']);
    expect(next[1].status).toBe('running');
  });
});

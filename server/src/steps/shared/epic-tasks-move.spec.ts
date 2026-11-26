import 'reflect-metadata';
import type { Subtask } from '../../contract/subtask';
import type { CommandRepository } from '../../history/command.repository';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { mainMovedNote } from '../implement/split-rebase';
import type { RunRebase } from '../run-rebase';
import { EpicTasksMove } from './epic-tasks-move';
import type { RebaseEvent, SubtaskOps } from './subtask-ops';

const TIP = 'billing@abc123';
const parent = { id: 1, key: 'PROJ-500' } as RunEntity;

const task = (id: string, status: Subtask['status']): Subtask => ({
  id,
  title: `Task ${id}`,
  description: '',
  depends: [],
  files: [],
  proof: id,
  status,
});

/** The tasks a fake SubtaskOps moved, with the event each was sent. */
interface Moved {
  id: string;
  event: RebaseEvent | undefined;
}

function mover(tasks: Subtask[], rebaseCommand: string | undefined, withoutRun: string[] = []) {
  const moved: Moved[] = [];
  const ops = {
    find: (_parent: RunEntity, id: string) =>
      Promise.resolve(withoutRun.includes(id) ? null : ({ key: `child-${id}` } as RunEntity)),
    rebase: (child: RunEntity, event?: RebaseEvent) => {
      moved.push({ id: child.key.replace('child-', ''), event });
      return Promise.resolve(true);
    },
  } as unknown as SubtaskOps;
  const rebase = { tipOf: () => Promise.resolve(TIP) } as unknown as RunRebase;
  const commands = {
    latestOfType: () => Promise.resolve(rebaseCommand === undefined ? null : { payload: rebaseCommand }),
  } as unknown as CommandRepository;
  const documents = { latestBody: () => Promise.resolve(JSON.stringify(tasks)) } as unknown as DocumentRepository;
  return { moved, move: new EpicTasksMove(ops, rebase, commands, documents) };
}

const tasks = [task('a', 'merged'), task('b', 'running'), task('c', 'blocked'), task('d', 'waiting')];

describe('EpicTasksMove', () => {
  it('moves each open task that has a run onto the tip with the note of the main the rebase command names', async () => {
    const { moved, move } = mover(tasks, JSON.stringify({ main: 'new-head' }), ['d']);

    await move.move(parent);

    expect(moved).toEqual([
      { id: 'b', event: { tip: TIP, note: mainMovedNote('new-head') } },
      { id: 'c', event: { tip: TIP, note: mainMovedNote('new-head') } },
    ]);
  });

  it("sends a person's Rebase the plain move, with no note", async () => {
    const { moved, move } = mover(tasks, JSON.stringify({}));

    await move.move(parent);

    expect(moved).toEqual([
      { id: 'b', event: undefined },
      { id: 'c', event: undefined },
      { id: 'd', event: undefined },
    ]);
  });

  it('moves no settled task', async () => {
    const { moved, move } = mover([task('a', 'merged'), task('b', 'skipped')], undefined);

    await move.move(parent);

    expect(moved).toEqual([]);
  });
});

import 'reflect-metadata';
import type { RunEntity } from '../../history/entities';
import { EpicRound } from './epic-round';
import type { EpicTasksMove } from './epic-tasks-move';
import type { SubtaskOps } from './subtask-ops';

const parent = { key: 'PROJ-500' } as RunEntity;

/** What a round did, in order: the commit of the own edits, then the move of the tasks. */
function round(own: { committed: string | null; conflict: string | null }) {
  const order: string[] = [];
  const ops = {
    commitOwnEdits: () => {
      order.push('commit');
      return Promise.resolve(own);
    },
  } as unknown as SubtaskOps;
  const move = {
    move: (moved: RunEntity) => {
      order.push(`move ${moved.key}`);
      return Promise.resolve();
    },
  } as unknown as EpicTasksMove;
  return { order, epicRound: new EpicRound(ops, move) };
}

describe('EpicRound', () => {
  it('commits the own edits of the epic, then moves its open tasks', async () => {
    const { order, epicRound } = round({ committed: null, conflict: null });

    expect(await epicRound.finish(parent)).toEqual({ conflict: null });
    expect(order).toEqual(['commit', 'move PROJ-500']);
  });

  it('moves no task and returns the conflict of the epic own edits', async () => {
    const { order, epicRound } = round({ committed: null, conflict: 'src/a.ts conflicts' });

    expect(await epicRound.finish(parent)).toEqual({ conflict: 'src/a.ts conflicts' });
    expect(order).toEqual(['commit']);
  });
});

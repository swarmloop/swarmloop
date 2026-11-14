import type { RunEntity } from './run.entity';
import { starterOf } from './run-starter';

type Row = Pick<RunEntity, 'id' | 'startedBy' | 'parentRunId'>;

function runsOf(rows: Row[]) {
  return { findById: async (id: number) => (rows.find((row) => row.id === id) as RunEntity | undefined) ?? null };
}

describe('starterOf', () => {
  it('gives the starter of a top-level run', async () => {
    const run = { id: 1, startedBy: 'ann', parentRunId: null };
    expect(await starterOf(runsOf([run]), run)).toBe('ann');
  });

  it('gives a subtask the starter of its parent', async () => {
    const parent = { id: 1, startedBy: 'ann', parentRunId: null };
    const subtask = { id: 2, startedBy: 'machine', parentRunId: 1 };
    expect(await starterOf(runsOf([parent, subtask]), subtask)).toBe('ann');
  });

  it('gives null for a run the CLI started', async () => {
    const run = { id: 1, startedBy: null, parentRunId: null };
    expect(await starterOf(runsOf([run]), run)).toBeNull();
  });

  it('gives null for a subtask whose parent has no starter or is gone', async () => {
    const parent = { id: 1, startedBy: null, parentRunId: null };
    const subtask = { id: 2, startedBy: 'ann', parentRunId: 1 };
    const orphan = { id: 3, startedBy: 'ann', parentRunId: 99 };
    expect(await starterOf(runsOf([parent, subtask, orphan]), subtask)).toBeNull();
    expect(await starterOf(runsOf([parent, subtask, orphan]), orphan)).toBeNull();
  });
});

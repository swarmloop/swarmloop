import 'reflect-metadata';
import type { RunEntity } from '../history/entities';
import { RunSettler } from './run-settler';

const JOURNAL = JSON.stringify({ repo: { checkpoint: 'applying', generation: 1, path: '/none', fingerprint: 'x' } });

/** A settler over an unfinished journal; `pending` are the types of the commands the run has still to run. */
function settlerWith(pending: string[]) {
  const rebased: string[] = [];
  const nothing = null as never;
  const settler = new RunSettler(
    { release: async (run: RunEntity) => run, findRun: async () => null } as never,
    { latestBody: async () => JOURNAL } as never,
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    nothing,
    { rebase: async (key: string) => void rebased.push(key) } as never,
    { ensure: async () => undefined } as never,
    nothing,
    nothing,
    nothing,
    nothing,
    { pending: async () => pending.map((type) => ({ type })) } as never,
  );
  return { settler, rebased };
}

const run = { id: 1, key: 'proj-1', status: 'running', generation: 1 } as RunEntity;

describe('RunSettler.settleRebase', () => {
  it('leaves a run with a rebase command still to run to that command, and rebases nothing itself', async () => {
    const { settler, rebased } = settlerWith(['rebase']);

    expect(await settler.settleRebase(run)).toBe(false);
    expect(rebased).toEqual([]);
  });

  it('settles the journal itself when the only pending command is not a rebase', async () => {
    const { settler } = settlerWith(['resume']);

    expect(await settler.settleRebase(run)).toBe(true);
  });
});

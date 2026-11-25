import { adoptRow, changedColumns, RunReadSubscriber, wasRead } from './run-read';
import type { RunEntity } from './entities';

function loaded(): RunEntity {
  const run = { id: 1, key: 'K-1', prompt: 'a', generation: 0, agents: { implement: 'x' } } as unknown as RunEntity;
  new RunReadSubscriber().afterLoad(run);
  return run;
}

describe('run-read', () => {
  it('gives only the column the copy changed', () => {
    const run = loaded();
    expect(changedColumns(run)).toEqual({});
    run.prompt = 'b';
    expect(changedColumns(run)).toEqual({ prompt: 'b' });
  });

  it('gives all columns but the id for a copy that was never read', () => {
    const run = { id: 1, key: 'K-1', prompt: 'a' } as RunEntity;
    expect(wasRead(run)).toBe(false);
    expect(changedColumns(run)).toEqual({ key: 'K-1', prompt: 'a' });
  });

  it('compares an object column by its value', () => {
    const run = loaded();
    run.agents = { implement: 'x' } as unknown as RunEntity['agents'];
    expect(changedColumns(run)).toEqual({});
    (run.agents as unknown as Record<string, string>).implement = 'y';
    expect(Object.keys(changedColumns(run))).toEqual(['agents']);
  });

  it('makes the copy and what it read the stored row', () => {
    const run = loaded();
    run.prompt = 'b';
    adoptRow(run, { id: 1, key: 'K-1', prompt: 'c', generation: 2, agents: null } as RunEntity);
    expect(run).toEqual(expect.objectContaining({ prompt: 'c', generation: 2 }));
    expect(changedColumns(run)).toEqual({});
  });
});

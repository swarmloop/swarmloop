import type { RunState } from '../contract/run-state';
import type { RunEntity } from './entities';
import { runOver } from './run-over';

function run(state: RunState, shape: 'plain' | 'epic' | 'part' = 'plain'): RunEntity {
  return {
    state,
    stateReason: null,
    parentRunId: shape === 'part' ? 1 : null,
    epicAt: shape === 'epic' ? '2026-11-27T00:00:00.000Z' : null,
  } as RunEntity;
}

describe('runOver', () => {
  it('is true for a run a person stopped', () => {
    expect(runOver(run('stopped'))).toBe(true);
  });

  it.each(['merged', 'done', 'failed', 'closed', 'skipped'] as RunState[])(
    'is true for a plain run that is %s',
    (state) => {
      expect(runOver(run(state))).toBe(true);
      expect(runOver(run(state, 'part'))).toBe(true);
    },
  );

  it.each(['running', 'idle', 'waiting', 'blocked'] as RunState[])('is false for a plain run that is %s', (state) => {
    expect(runOver(run(state))).toBe(false);
  });

  it('is true for an epic parent that merged, closed or was skipped', () => {
    for (const state of ['merged', 'closed', 'skipped'] as RunState[]) expect(runOver(run(state, 'epic'))).toBe(true);
  });

  it('is false for an epic parent that is done or failed, which still gets answers and a merge look', () => {
    for (const state of ['done', 'failed'] as RunState[]) expect(runOver(run(state, 'epic'))).toBe(false);
  });
});

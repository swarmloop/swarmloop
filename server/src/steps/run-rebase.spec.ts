import { ConflictException } from '@nestjs/common';
import { RunRebase } from './run-rebase';
import { actionsFor, REASON, type RunState } from '../contract/run-state';
import { deriveState, writeRunState } from '../history/run-state';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import type { RunEntity } from '../history/entities';

const PAST_GUARD = 'past the guard';

/** Each state a stored run can derive to without extra facts, with the stored row that gives it. */
const ROWS: {
  state: RunState;
  status: string;
  code?: string;
  merge?: { closed: { repo: string; by: null; at: string } };
}[] = [
  { state: 'idle', status: 'waiting' },
  { state: 'running', status: 'running' },
  { state: 'waiting', status: 'waiting', code: 'RUNTIME_LIMIT' },
  { state: 'stopped', status: 'blocked', code: REASON.stopped },
  { state: 'stopped', status: 'failed', code: REASON.stopped },
  { state: 'blocked', status: 'blocked', code: REASON.ciNotRun },
  { state: 'blocked', status: 'blocked' },
  { state: 'failed', status: 'failed' },
  { state: 'done', status: 'done' },
  { state: 'closed', status: 'done', merge: { closed: { repo: 'demo', by: null, at: '2026-11-11' } } },
];

function rebaseOf(run: RunEntity, backToDraft: () => Promise<void> = async () => undefined): RunRebase {
  const runs = {
    findRun: async () => run,
    bumpGeneration: async () => {
      throw new Error(PAST_GUARD);
    },
  };
  const drafts = { backToDraft };
  return new RunRebase(
    runs as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    drafts as never,
    {} as never,
  );
}

function runOf(row: (typeof ROWS)[number]): RunEntity {
  const run = {
    key: 'f36-1',
    split: false,
    currentStep: 'implement',
    stateReason: null,
    mergeOutcome: null,
  } as unknown as RunEntity;
  writeRunState(run, {
    status: row.status,
    currentStep: 'implement',
    reason: row.code ? { code: row.code, message: 'why' } : undefined,
    merge: row.merge,
  });
  return run;
}

describe('run rebase', () => {
  it.each([
    ['a blocked subtask the parent moves', { parentRunId: 7 }, true, PAST_GUARD],
    ['a working subtask the parent moves', { parentRunId: 7 }, true, PAST_GUARD],
    ['a blocked subtask a person moves', { parentRunId: 7 }, false, 'f36-1 is blocked'],
    ['a blocked run that is no subtask', { parentRunId: null }, true, 'f36-1 is blocked'],
  ])('takes %s only as the parent sends it', async (name, link, byParent, outcome) => {
    const run = { ...runOf({ state: 'blocked', status: 'blocked' }), ...link };
    if (name.includes('working')) writeRunState(run, { status: 'running', currentStep: 'implement' });

    await expect(rebaseOf(run).rebase('f36-1', false, byParent)).rejects.toThrow(outcome);
  });

  it.each(ROWS)('follows what actionsFor offers for $status run in state $state', async (row) => {
    const run = runOf(row);
    const { state, reason } = deriveState(run);
    expect(state).toBe(row.state);
    const offered = actionsFor(state, reason?.code ?? null).includes('rebase');
    const rebase = rebaseOf(run).rebase('f36-1');
    if (offered) {
      await expect(rebase).rejects.toThrow(PAST_GUARD);
    } else {
      await expect(rebase).rejects.toThrow(new ConflictException(`f36-1 is ${state}`).message);
    }
  });

  it('rebases a stopped run, which Rebase is offered to', async () => {
    const run = runOf({ state: 'stopped', status: 'blocked', code: REASON.stopped });
    await expect(rebaseOf(run).rebase('f36-1')).rejects.toThrow(PAST_GUARD);
  });

  it('lets an outage of the host through when the merge request goes back to draft', async () => {
    const run = runOf({ state: 'stopped', status: 'blocked', code: REASON.stopped });
    const outage = new HostUnavailable('api.github.com', 'HTTP 503', '2026-11-12T15:00:00.000Z');
    await expect(rebaseOf(run, () => Promise.reject(outage)).rebase('f36-1')).rejects.toBe(outage);
  });

  it('turns any other error of the draft call into a conflict', async () => {
    const run = runOf({ state: 'stopped', status: 'blocked', code: REASON.stopped });
    const refused = () => Promise.reject(new SwarmloopError('draft refused'));
    await expect(rebaseOf(run, refused).rebase('f36-1')).rejects.toThrow(
      new ConflictException('draft refused').message,
    );
  });
});

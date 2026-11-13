import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import { actionsFor, REASON } from '../contract/run-state';
import type { RunAction, RunState } from '../contract/run-state';
import { blockCode, clearEpic, deriveState, markEpic, stateColumns, writeRunState } from './run-state';

const GOLDEN_DIR = join(__dirname, '..', 'testing', 'golden');

/** Every status and step the goldens record for a run. */
function goldenRuns(): { status: string; currentStep: string }[] {
  const found = new Map<string, { status: string; currentStep: string }>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.status === 'string' && typeof record.currentStep === 'string') {
      found.set(`${record.status}/${record.currentStep}`, { status: record.status, currentStep: record.currentStep });
    }
    Object.values(record).forEach(walk);
  };
  for (const name of readdirSync(GOLDEN_DIR).filter((file) => file.endsWith('.json'))) {
    walk(JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')));
  }
  return [...found.values()];
}

const STATE_OF_STATUS: Record<string, RunState> = {
  waiting: 'idle',
  running: 'running',
  failed: 'failed',
  blocked: 'blocked',
  done: 'done',
};

describe('deriveState', () => {
  it('maps every status and step the goldens record', () => {
    const runs = goldenRuns();
    expect(runs.length).toBeGreaterThan(20);
    for (const run of runs) {
      expect({ run, state: deriveState(run).state }).toEqual({ run, state: STATE_OF_STATUS[run.status] });
    }
  });

  it('shows a run that waits for a provider limit as waiting, with its reason and when it goes on', () => {
    const limit = { runtime: 'claude', resumesAt: '2026-11-08T21:51:00.000Z' };
    const stateReason = JSON.stringify({
      code: ERROR_CODES.RUNTIME_LIMIT,
      message: 'Claude hit its usage limit.',
      limit,
    });
    expect(deriveState({ status: 'waiting', stateReason })).toEqual({
      state: 'waiting',
      reason: { code: ERROR_CODES.RUNTIME_LIMIT, message: 'Claude hit its usage limit.', limit },
    });
  });

  it('keeps waiting after ok idle, and a person needed waiting', () => {
    expect(deriveState({ status: 'waiting' })).toEqual({ state: 'idle', reason: null });
    expect(deriveState({ status: 'waiting' }, { needsAnswers: true }).state).toBe('waiting');
  });

  it('calls a return to implement idle with the reason RETURNED', () => {
    expect(deriveState({ status: 'waiting' }, { returned: true })).toEqual({
      state: 'idle',
      reason: { code: REASON.returned, message: 'returned to implement' },
    });
  });

  it('derives queued, stopping and stopped from the facts and the stored Stop', () => {
    expect(deriveState({ status: 'waiting' }, { queued: true }).state).toBe('queued');
    expect(deriveState({ status: 'running' }, { stopping: true }).state).toBe('stopping');
    const stopped = JSON.stringify({ code: REASON.stopped, message: 'stopped' });
    expect(deriveState({ status: 'failed', stateReason: stopped }).state).toBe('stopped');
    expect(deriveState({ status: 'failed' }).state).toBe('failed');
  });

  it('gives a block its code', () => {
    expect(deriveState({ status: 'blocked' }, { blockCode: REASON.checkFailed }).reason?.code).toBe('CHECK_FAILED');
    expect(deriveState({ status: 'blocked' }).reason?.code).toBe('BLOCKED');
  });
});

describe('blockCode', () => {
  it('tells a repeated check, a budget that does not fit, a loop step and any other block apart', () => {
    expect(blockCode('implement-improve', 'repo: npm test failed again on unchanged files after a relaunch')).toBe(
      REASON.checkFailed,
    );
    expect(blockCode('code-review', 'code-review does not fit')).toBe(REASON.didNotFit);
    expect(blockCode('pipeline', null)).toBe(REASON.loopLimit);
    expect(blockCode('prepare', 'x')).toBe(REASON.blocked);
    expect(blockCode('pipeline', 'CI_LOG_UNAVAILABLE: a failed job has no readable log')).toBe(REASON.ciLogUnavailable);
    expect(blockCode('pipeline', 'CI_NOT_RUN: CI did not run lint')).toBe(REASON.ciNotRun);
    expect(blockCode('pipeline', 'CI_TIMEOUT: lint timed out')).toBe(REASON.ciTimeout);
    const flaky = 'TEST_FLAKY: a test failed and passed on the same code twice; fix the race, not the test';
    expect(blockCode('pipeline', flaky)).toBe(ERROR_CODES.TEST_FLAKY);
    expect(blockCode('prepare', flaky)).toBe(ERROR_CODES.TEST_FLAKY);
  });
});

describe('actionsFor', () => {
  const table: [RunState, string | null, RunAction[]][] = [
    ['idle', null, ['resume', 'replay', 'rebase']],
    ['idle', REASON.returned, ['resume', 'replay', 'rebase']],
    ['queued', null, []],
    ['running', null, ['stop', 'replay']],
    ['waiting', null, ['answer', 'replay', 'rebase']],
    ['waiting', ERROR_CODES.RUNTIME_LIMIT, ['resume', 'replay', 'rebase']],
    ['stopping', null, ['stop']],
    ['stopped', REASON.stopped, ['resume', 'replay', 'rebase']],
    ['recovering', null, []],
    ['failed', null, ['resume', 'replay', 'rebase']],
    ['done', null, ['replay', 'rebase']],
    ['merged', null, []],
    ['closed', null, ['replay']],
    ['blocked', REASON.checkFailed, ['resume', 'replay']],
    ['blocked', REASON.didNotFit, ['resume', 'replay']],
    ['blocked', REASON.loopLimit, ['resume', 'replay']],
    ['blocked', REASON.ciLogUnavailable, ['resume', 'replay']],
    ['blocked', REASON.ciNotRun, ['resume', 'replay']],
    ['blocked', REASON.ciTimeout, ['resume', 'replay']],
    ['blocked', REASON.blocked, ['replay']],
    ['blocked', null, ['replay']],
  ];

  it.each(table)('allows for %s with reason %s: %j', (state, code, actions) => {
    expect(actionsFor(state, code)).toEqual(actions);
  });
});

describe('deriveState of a done run', () => {
  const merged = JSON.stringify({ merged: { 'acme/demo': { sha: 'abc', by: 'ada', at: '2026-05-01T10:00:00Z' } } });
  const closed = JSON.stringify({ closed: { repo: 'acme/demo', by: 'grace', at: '2026-05-02T08:00:00Z' } });
  const note = JSON.stringify({ code: REASON.mergeWatchUnavailable, message: 'cannot read' });

  it('is done while the merge request waits, merged or closed once the outcome is stored', () => {
    expect(deriveState({ status: 'done' }).state).toBe('done');
    expect(deriveState({ status: 'done', mergeOutcome: merged }).state).toBe('merged');
    expect(deriveState({ status: 'done', mergeOutcome: closed }).state).toBe('closed');
  });

  it('shows the stored note of a done run', () => {
    expect(deriveState({ status: 'done', stateReason: note }).reason?.code).toBe(REASON.mergeWatchUnavailable);
  });

  it('writes the outcome with the state, keeps it while done, and clears it when the run leaves done', () => {
    const outcome = { closed: { repo: 'acme/demo', by: null, at: '2026-05-02T08:00:00Z' } };
    const row = { currentStep: 'done', ownerInstance: null, activeAttempt: null, mergeOutcome: null, doneAt: null };
    const settled = stateColumns(row, { status: 'done', merge: outcome, doneAt: '2026-05-01T00:00:00Z' });
    expect(settled).toMatchObject({ state: 'closed', doneAt: '2026-05-01T00:00:00Z' });
    expect(JSON.parse(settled.mergeOutcome!)).toEqual(outcome);

    expect(stateColumns({ ...row, ...settled }, { status: 'done' })).toMatchObject({
      state: 'closed',
      mergeOutcome: settled.mergeOutcome,
      doneAt: settled.doneAt,
    });
    expect(stateColumns({ ...row, ...settled }, { status: 'running' })).toMatchObject({
      state: 'running',
      mergeOutcome: null,
      doneAt: null,
    });
  });
});

describe('writeRunState', () => {
  it('writes the status with its state, and frees the owner', () => {
    const run = {
      status: 'running',
      currentStep: 'implement',
      ownerPid: 7,
      ownerInstance: 'a',
      activeAttempt: 'b',
      state: 'running',
      stateReason: null,
    };

    writeRunState(run, { status: 'blocked', reason: { code: REASON.checkFailed, message: 'again' } });

    expect(run).toMatchObject({
      status: 'blocked',
      currentStep: 'implement',
      ownerPid: null,
      ownerInstance: 'a',
      activeAttempt: 'b',
      state: 'blocked',
      stateReason: JSON.stringify({ code: 'CHECK_FAILED', message: 'again' }),
    });
  });

  it('keeps the step unless the change names one', () => {
    const base = { currentStep: 'plan', ownerInstance: null, activeAttempt: null };

    expect(stateColumns(base, { status: 'waiting' }).currentStep).toBe('plan');
    expect(stateColumns(base, { status: 'waiting', currentStep: 'implement' }).currentStep).toBe('implement');
  });
});

describe('deriveState of a split run between passes', () => {
  const reason = (code: string) => JSON.stringify({ code, message: '1/2 merged · 1 running' });

  it.each([ERROR_CODES.SUBTASKS_RUNNING, ERROR_CODES.SUBTASK_WAITING])('a waiting run with %s is waiting', (code) => {
    expect(deriveState({ status: 'waiting', stateReason: reason(code) })).toMatchObject({
      state: 'waiting',
      reason: { code },
    });
  });

  it('keeps SUBTASK_BLOCKED for a blocked run', () => {
    expect(
      deriveState(
        { status: 'blocked', stateReason: reason(ERROR_CODES.SUBTASK_BLOCKED) },
        { blockCode: REASON.blocked },
      ),
    ).toMatchObject({ state: 'blocked', reason: { code: ERROR_CODES.SUBTASK_BLOCKED } });
  });
});

describe('deriveState of a run with a next try', () => {
  const retryAt = '2026-11-12T14:05:00.000Z';
  const stored = (code: string) => JSON.stringify({ code, message: 'did not answer', retryAt });

  it.each([ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.CI_NOT_STARTED, ERROR_CODES.DOCKER_UNAVAILABLE])(
    'a waiting run with %s is waiting',
    (code) => {
      expect(deriveState({ status: 'waiting', stateReason: stored(code) })).toEqual({
        state: 'waiting',
        reason: { code, message: 'did not answer', retryAt },
      });
    },
  );

  it('keeps the next try through a write', () => {
    const run = {
      status: 'running',
      currentStep: 'pipeline',
      ownerPid: 1,
      ownerInstance: 'a',
      activeAttempt: 'x',
    } as Parameters<typeof writeRunState>[0];
    writeRunState(run, {
      status: 'waiting',
      reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: 'did not answer', retryAt },
    });
    expect(run.state).toBe('waiting');
    expect(deriveState({ status: run.status, stateReason: run.stateReason }).reason?.retryAt).toBe(retryAt);
  });
});

describe('deriveState of a block that a person must clear', () => {
  const stored = (code: string) => JSON.stringify({ code, message: 'stopped' });

  it.each([REASON.loopLimit, ERROR_CODES.SPEND_LIMIT, ERROR_CODES.PIPELINE_UNFIXED])('keeps the stored %s', (code) => {
    expect(deriveState({ status: 'blocked', stateReason: stored(code) }, { blockCode: REASON.blocked })).toMatchObject({
      state: 'blocked',
      reason: { code },
    });
  });

  it('keeps a stored RESOURCE_UNKNOWN and reads a blocked DOCKER_UNAVAILABLE as before', () => {
    expect(
      deriveState(
        { status: 'blocked', stateReason: stored(ERROR_CODES.RESOURCE_UNKNOWN) },
        { blockCode: REASON.blocked },
      ),
    ).toMatchObject({ state: 'blocked', reason: { code: ERROR_CODES.RESOURCE_UNKNOWN } });
    expect(deriveState({ status: 'blocked', stateReason: stored(ERROR_CODES.DOCKER_UNAVAILABLE) }, {})).toMatchObject({
      state: 'blocked',
      reason: { code: ERROR_CODES.DOCKER_UNAVAILABLE },
    });
  });
});

describe('the epic mark', () => {
  it('markEpic sets the time the plan split and clearEpic clears it', () => {
    const run = { epicAt: null as string | null };
    markEpic(run, '2026-11-13T10:00:00.000Z');
    expect(run.epicAt).toBe('2026-11-13T10:00:00.000Z');
    clearEpic(run);
    expect(run.epicAt).toBeNull();
  });
});

describe('deriveState of a skipped task', () => {
  it.each(['failed', 'blocked', 'waiting', 'running'])('is skipped whatever the status (%s)', (status) => {
    const stateReason = JSON.stringify({ code: REASON.skipped, message: 'this task was skipped' });
    expect(deriveState({ status, stateReason }).state).toBe('skipped');
  });
});

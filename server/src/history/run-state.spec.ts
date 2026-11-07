import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { actionsFor, REASON } from '../contract/run-state';
import type { RunAction, RunState } from '../contract/run-state';
import { blockCode, deriveState, stateColumns, writeRunState } from './run-state';

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
  });
});

describe('actionsFor', () => {
  const table: [RunState, string | null, RunAction[]][] = [
    ['idle', null, ['resume', 'replay', 'rebase']],
    ['idle', REASON.returned, ['resume', 'replay', 'rebase']],
    ['queued', null, []],
    ['running', null, ['stop', 'replay']],
    ['waiting', null, ['answer', 'replay', 'rebase']],
    ['stopping', null, ['stop']],
    ['stopped', REASON.stopped, ['resume', 'replay', 'rebase']],
    ['recovering', null, []],
    ['failed', null, ['resume', 'replay', 'rebase']],
    ['done', null, ['replay', 'rebase']],
    ['blocked', REASON.checkFailed, ['resume', 'replay']],
    ['blocked', REASON.didNotFit, ['resume', 'replay']],
    ['blocked', REASON.loopLimit, ['resume', 'replay']],
    ['blocked', REASON.blocked, ['replay']],
    ['blocked', null, ['replay']],
  ];

  it.each(table)('allows for %s with reason %s: %j', (state, code, actions) => {
    expect(actionsFor(state, code)).toEqual(actions);
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

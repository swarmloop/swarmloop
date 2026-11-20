import { ETA_MIN_MS, WAITS_FOR_YOU } from '../contract/eta';
import { at, emptyTable, liveRun, MIN, NOW } from './eta.spec-helpers';
import { runEta } from './run-eta';
import { SEED_RUN_MS, seedFor } from './seed';

const table = () => ({ ...emptyTable(), plain: { steps: { implement: 30 * MIN }, whole: null } });

describe('runEta', () => {
  it('subtracts the time already spent in the step', () => {
    const eta = runEta(liveRun({ stepStartedAt: at(-10) }), table(), NOW);
    expect(eta).toEqual({ leftMs: 20 * MIN, doneAt: at(20) });
  });

  it('never goes below one minute', () => {
    expect(runEta(liveRun({ stepStartedAt: at(-90) }), table(), NOW)?.leftMs).toBe(ETA_MIN_MS);
  });

  it('leaves waits out of the time spent', () => {
    const waits = [{ from: at(-8), to: null }];
    expect(runEta(liveRun({ stepStartedAt: at(-10), waits }), table(), NOW)?.leftMs).toBe(28 * MIN);
  });

  it('gives none to a run that waits for a person', () => {
    const run = liveRun({ state: 'blocked', reason: { code: 'NEEDS_ANSWERS', message: 'x' } });
    expect(runEta(run, table(), NOW)).toEqual(WAITS_FOR_YOU);
    expect(runEta(liveRun({ state: 'stopped' }), table(), NOW)).toEqual(WAITS_FOR_YOU);
  });

  it('adds the time to the next try of a limit wait', () => {
    const limit = { runtime: 'agent', resumesAt: at(15) };
    const run = liveRun({ state: 'waiting', reason: { code: 'RUNTIME_LIMIT', message: 'x', limit } });
    expect(runEta(run, table(), NOW)?.leftMs).toBe(45 * MIN);
  });

  it('gives a finite estimate from the seed with no history', () => {
    const eta = runEta(liveRun(), emptyTable(), NOW);
    expect(eta?.leftMs).toBe(seedFor('implement'));
    expect(runEta(liveRun({ currentStep: 'unknown-step' }), emptyTable(), NOW)?.leftMs).toBe(SEED_RUN_MS);
  });

  it('gives none to an ended run', () => {
    expect(runEta(liveRun({ state: 'done' }), table(), NOW)).toBeUndefined();
  });
});

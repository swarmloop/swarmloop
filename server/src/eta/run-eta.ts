import { ETA_MIN_MS, WAITS_FOR_YOU, etaPhase, nextTryAt } from '../contract/eta';
import type { RunEta } from '../contract/eta';
import type { EtaTable, LiveRun } from './eta.types';
import { STEPS } from '../contract/steps';
import { SEED_RUN_MS, seedFor } from './seed';
import { workingMs } from './working-time';

/** The estimate for a time left, with the time it should be done. */
export function etaAfter(leftMs: number, now: string): RunEta {
  return { leftMs, doneAt: new Date(Date.parse(now) + leftMs).toISOString() };
}

/** One visit of a step while the server has no history of it: a share of the seed of a whole run. */
const SEED_VISIT_MS = SEED_RUN_MS / STEPS.length;

/** The time the steps of an open relaunch take: one visit each, less what the current one has already used. */
function relaunchLeft(run: LiveRun, steps: readonly string[], table: EtaTable, now: string): number {
  const visits = table[run.kind].visits;
  const total = steps.reduce((sum, step) => sum + (visits[step] ?? SEED_VISIT_MS), 0);
  const spent = run.stepStartedAt && steps.includes(run.currentStep) ? workingMs(run.stepStartedAt, now, run.waits) : 0;
  return total - spent;
}

/** The time from the current step to the end of the run, by the numbers of finished runs. */
function stepLeft(run: LiveRun, table: EtaTable, now: string): number {
  const number = table[run.kind].steps[run.currentStep] ?? seedFor(run.currentStep);
  const spent = run.stepStartedAt ? workingMs(run.stepStartedAt, now, run.waits) : 0;
  return number - spent;
}

/** The estimate of a run: `undefined` when it has ended, `WAITS_FOR_YOU` when it waits for a person. */
export function runEta(run: LiveRun, table: EtaTable, now: string): RunEta | undefined {
  const phase = etaPhase(run.state, run.reason);
  if (phase === 'ended') {
    return undefined;
  }
  if (phase === 'person') {
    return WAITS_FOR_YOU;
  }
  let left = Math.max(
    ETA_MIN_MS,
    run.relaunch ? relaunchLeft(run, run.relaunch, table, now) : stepLeft(run, table, now),
  );
  const retryAt = nextTryAt(run.reason);
  if (phase === 'timed' && retryAt !== null) {
    left += Math.max(0, Date.parse(retryAt) - Date.parse(now));
  }
  return etaAfter(left, now);
}

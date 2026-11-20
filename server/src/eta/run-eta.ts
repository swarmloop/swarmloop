import { ETA_MIN_MS, WAITS_FOR_YOU, etaPhase, nextTryAt } from '../contract/eta';
import type { RunEta } from '../contract/eta';
import type { EtaTable, LiveRun } from './eta.types';
import { seedFor } from './seed';
import { workingMs } from './working-time';

/** The estimate for a time left, with the time it should be done. */
export function etaAfter(leftMs: number, now: string): RunEta {
  return { leftMs, doneAt: new Date(Date.parse(now) + leftMs).toISOString() };
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
  const number = table[run.kind].steps[run.currentStep] ?? seedFor(run.currentStep);
  const spent = run.stepStartedAt ? workingMs(run.stepStartedAt, now, run.waits) : 0;
  let left = Math.max(ETA_MIN_MS, number - spent);
  const retryAt = nextTryAt(run.reason);
  if (phase === 'timed' && retryAt !== null) {
    left += Math.max(0, Date.parse(retryAt) - Date.parse(now));
  }
  return etaAfter(left, now);
}

import type { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import type { VisitRepository } from '../history/visit.repository';
import { writeRunState } from '../history/run-state';
import { REASON, STOP_NOTE } from '../contract/run-state';

/** The kill reason a Stop leaves on the visit it ends. */
const STOP_KILL_REASON = 'stop';

/**
 * Closes the active attempt of a stopped run as a killed visit and stores the run blocked STOPPED in one finalize.
 * A late finalize of the same attempt finds it changed and stores nothing.
 */
export async function closeStopped(visits: VisitRepository, clock: Clock, run: RunEntity): Promise<void> {
  const now = clock.iso();
  writeRunState(run, {
    status: 'blocked',
    ownerPid: null,
    reason: { code: REASON.stopped, message: STOP_NOTE },
  });
  await visits.finalize(run.activeAttempt, run, {
    step: run.currentStep,
    model: null,
    mode: null,
    startedAt: run.stepStartedAt ?? now,
    finishedAt: now,
    durationMs: stepElapsed(run.stepStartedAt, clock.now()),
    status: 'killed',
    exitCode: 1,
    killReason: STOP_KILL_REASON,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    samples: [],
    httpCalls: [],
    document: null,
    documents: [],
    resumed: false,
  });
}

export function stepElapsed(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

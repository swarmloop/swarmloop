import { ERROR_CODES } from '../contract/error-codes';
import { AUTO_RETRY_CODES, NEEDS_PERSON, type RunState, type StateReason } from '../contract/run-state';
import type { StepStatEntity } from '../history/entities';
import { deriveState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import type { TestApp } from './test-app';

const TIMED_CODES: readonly string[] = [ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.DOCKER_UNAVAILABLE];

/**
 * What must hold for every run after a reconciler tick. It throws one error that lists each run and rule that broke.
 * The codes that need a person and the codes that end by themselves come from `contract/run-state.ts`.
 */
export async function assertInvariants(app: TestApp): Promise<void> {
  const runs = app.app.get(RunRepository);
  const visits = app.app.get(VisitRepository);
  const broken: string[] = [];
  for (const run of await runs.listRuns()) {
    const { state, reason } = deriveState(run);
    broken.push(
      ...stateRules(run.key, state, reason),
      ...visitRules(run.key, state, reason, await visits.listStats(run.id)),
    );
  }
  if (broken.length > 0) throw new Error(broken.join('\n'));
}

/** A stop is on the needs-a-person list, and a wait or a stop says what happens next. */
function stateRules(key: string, state: RunState, reason: StateReason | null): string[] {
  const broken: string[] = [];
  const code = reason?.code ?? (state === 'failed' ? ERROR_CODES.STEP_FAILED : null);
  if ((state === 'failed' || state === 'blocked') && !(code && code in NEEDS_PERSON)) {
    broken.push(`${key} is ${state} with ${code ?? 'no code'}, which is not on the needs-a-person list`);
  }
  if ((state === 'waiting' || state === 'blocked') && !saysWhatNext(code, reason?.message, reason?.retryAt)) {
    broken.push(`${key} is ${state} and its reason does not say what happens next`);
  }
  return broken;
}

/** A started run is not idle without a reason, and every visit that ended has its result. */
function visitRules(key: string, state: RunState, reason: StateReason | null, stats: StepStatEntity[]): string[] {
  const broken: string[] = [];
  if (state === 'idle' && !reason && stats.length > 0) broken.push(`${key} started and is idle with no reason`);
  for (const stat of stats) {
    if (!stat.status || !stat.finishedAt) broken.push(`${key} visit ${stat.id} of ${stat.step} has no result`);
  }
  return broken;
}

/** An automatic next try names its time; a stop names the action a person takes. */
function saysWhatNext(code: string | null, message: string | undefined, retryAt: string | undefined): boolean {
  if (!code || !message) return false;
  if (TIMED_CODES.includes(code)) return Boolean(retryAt);
  return AUTO_RETRY_CODES.includes(code) || code in NEEDS_PERSON;
}

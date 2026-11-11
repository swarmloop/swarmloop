import { isLoopStep } from '../core/pipeline-result';
import { SERVER_INSTANCE } from '../core/server-instance';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import type { ErrorCode } from '../contract/error-codes';
import { isStopNote, REASON } from '../contract/run-state';
import type { RunState, StateReason } from '../contract/run-state';
import type { RunEntity } from './entities';

/** What the run row alone cannot say. */
export interface StateFacts {
  /** A Stop is accepted and has not finished. */
  stopping?: boolean;
  /** The owner is gone and its container still runs: the run waits for it. */
  recovering?: boolean;
  /** A command is accepted and the run is not claimed yet. */
  queued?: boolean;
  /** An open question or a link still waits for a person. */
  needsAnswers?: boolean;
  /** The run went back to implementation after a review or pipeline return. */
  returned?: boolean;
  /** Why a blocked run is blocked. */
  blockCode?: string;
}

type StateRow = Pick<RunEntity, 'status'> & { stateReason?: string | null };

/** Why a run is blocked, from the step and the error text of its last visit. */
export function blockCode(step: string, error: string | null): string {
  if (isStopNote(error ?? '')) return REASON.stopped;
  if ((error ?? '').includes('does not fit')) return REASON.didNotFit;
  if ((error ?? '').includes('failed again on unchanged files after a relaunch')) return REASON.checkFailed;
  if ((error ?? '').includes(REASON.ciLogUnavailable)) return REASON.ciLogUnavailable;
  if ((error ?? '').includes(REASON.ciNotRun)) return REASON.ciNotRun;
  if ((error ?? '').includes(REASON.ciTimeout)) return REASON.ciTimeout;
  return isLoopStep(step) ? REASON.loopLimit : REASON.blocked;
}

function readReason(stored: string | null | undefined): StateReason | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<StateReason>;
    return typeof parsed.code === 'string'
      ? { code: parsed.code, message: String(parsed.message ?? ''), ...(parsed.limit ? { limit: parsed.limit } : {}) }
      : null;
  } catch {
    return null;
  }
}

/** Today's facts to the honest state. The only place that maps `status` and the facts to a state. */
export function deriveState(run: StateRow, facts: StateFacts = {}): { state: RunState; reason: StateReason | null } {
  const stored = readReason(run.stateReason);
  const reason = (code: string, message: string): StateReason => ({ code, message });
  switch (run.status) {
    case 'running':
      if (facts.recovering) return { state: 'recovering', reason: stored };
      return { state: facts.stopping ? 'stopping' : 'running', reason: null };
    case 'done':
      return { state: 'done', reason: null };
    case 'blocked': {
      // A code the stop path or a step wrote stays: the error text of the last visit cannot say it.
      const kept =
        stored?.code === REASON.stopped ||
        stored?.code === ERROR_CODES.RESOURCE_UNKNOWN ||
        stored?.code === ERROR_CODES.INPUT_MISSING ||
        stored?.code === ERROR_CODES.SUBTASK_BLOCKED;
      const code = kept ? stored.code : (facts.blockCode ?? stored?.code ?? REASON.blocked);
      return {
        state: code === REASON.stopped ? 'stopped' : 'blocked',
        reason: reason(code, stored?.message ?? 'blocked'),
      };
    }
    case 'failed':
      return stored?.code === REASON.stopped
        ? { state: 'stopped', reason: stored }
        : { state: 'failed', reason: stored };
    default:
      if (facts.queued) return { state: 'queued', reason: null };
      if (
        stored &&
        (stored.code === ERROR_CODES.RUNTIME_LIMIT ||
          stored.code === ERROR_CODES.GIT_AUTH ||
          SUBTASK_WAIT_CODES.includes(stored.code as ErrorCode))
      )
        return { state: 'waiting', reason: stored };
      if (facts.needsAnswers) return { state: 'waiting', reason: reason('NEEDS_ANSWERS', 'waiting for a person') };
      if (facts.returned) return { state: 'idle', reason: reason(REASON.returned, 'returned to implement') };
      return { state: 'idle', reason: null };
  }
}

export interface RunStateChange {
  status: string;
  currentStep?: string;
  ownerPid?: number | null;
  ownerInstance?: string | null;
  activeAttempt?: string | null;
  reason?: StateReason | null;
  facts?: StateFacts;
}

type StateColumns = Pick<
  RunEntity,
  'status' | 'currentStep' | 'ownerPid' | 'ownerInstance' | 'activeAttempt' | 'state' | 'stateReason'
>;

/** The columns of a run row that `change` sets. Used for an insert and for a conditional update. */
export function stateColumns(
  current: Pick<StateColumns, 'currentStep' | 'ownerInstance' | 'activeAttempt'>,
  change: RunStateChange,
): StateColumns {
  const status = change.status;
  const derived = deriveState(
    { status, stateReason: change.reason ? JSON.stringify(change.reason) : null },
    change.facts,
  );
  const reason = change.reason ?? derived.reason;
  return {
    status,
    currentStep: change.currentStep ?? current.currentStep,
    ownerPid: change.ownerPid ?? null,
    ownerInstance: change.ownerInstance === undefined ? current.ownerInstance : change.ownerInstance,
    activeAttempt: change.activeAttempt === undefined ? current.activeAttempt : change.activeAttempt,
    state: derived.state,
    stateReason: reason ? JSON.stringify(reason) : null,
  };
}

/** Moves a run to a state in memory. Persist it with `saveRun`, `claim` or `finalize`. */
export function writeRunState(run: StateColumns, change: RunStateChange): void {
  Object.assign(run, stateColumns(run, change));
}

/** The columns of a run that a step takes. */
export function claimedColumns(step: string, activeAttempt: string): StateColumns {
  return stateColumns(
    { currentStep: step, ownerInstance: SERVER_INSTANCE, activeAttempt },
    { status: 'running', currentStep: step, ownerPid: process.pid, ownerInstance: SERVER_INSTANCE, activeAttempt },
  );
}

/** The columns that free a run when a visit is stored. Status and step are the caller's. */
export function releasedColumns(): Pick<StateColumns, 'ownerPid' | 'activeAttempt'> {
  return { ownerPid: null, activeAttempt: null };
}

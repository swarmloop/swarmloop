import { SERVER_INSTANCE } from '../core/server-instance';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import type { ErrorCode } from '../contract/error-codes';
import { NEEDS_ANSWERS, REASON } from '../contract/run-state';
import type { MergeOutcome, RunState, StateReason } from '../contract/run-state';
import type { StoredAgents } from '../contract/api';
import type { RunEntity } from './entities';

/** What the run row alone cannot say. */
export interface StateFacts {
  /** A Stop is accepted and has not finished. */
  stopping?: boolean;
  /** The owner is gone and its container still runs: the run waits for it. */
  recovering?: boolean;
  /** A command is accepted or executing and the run is not claimed yet. */
  queued?: boolean;
  /** An open question or a link still waits for a person. */
  needsAnswers?: boolean;
  /** An open question waits for the planner of the backlog, not yet for a person. */
  asksPlanner?: boolean;
  /** What the agent starts of a running run wait for before their first output: a free place or the server's pause. */
  startWait?: StateReason;
}

type StateRow = Pick<RunEntity, 'status'> &
  Partial<Pick<RunEntity, 'currentStep' | 'attemptsReview' | 'attemptsPipeline' | 'attemptsChecks'>> & {
    stateReason?: string | null;
    mergeOutcome?: string | null;
  };

/** Statuses whose writers store the whole state: the facts of the documents do not change it. */
export const WRITTEN_WHOLE = ['running', 'done', 'failed'];

function readReason(stored: string | null | undefined): StateReason | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<StateReason>;
    return typeof parsed.code === 'string'
      ? {
          code: parsed.code,
          message: String(parsed.message ?? ''),
          ...(parsed.limit ? { limit: parsed.limit } : {}),
          ...(typeof parsed.retryAt === 'string' ? { retryAt: parsed.retryAt } : {}),
          ...(parsed.refusedStart === true ? { refusedStart: true as const } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** The outcome of a done run's merge requests, null while they wait or when the stored text is not one. */
export function readOutcome(stored: string | null | undefined): MergeOutcome | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<MergeOutcome>;
    return 'merged' in parsed || 'closed' in parsed ? (parsed as MergeOutcome) : null;
  } catch {
    return null;
  }
}

function reasonOf(code: string, message: string): StateReason {
  return { code, message };
}

/** A blocked run is blocked for the code its writer stored; a block that stored none is a plain block. */
function blockedState(stored: StateReason | null): { state: RunState; reason: StateReason } {
  const code = stored?.code ?? REASON.blocked;
  return {
    state: code === REASON.stopped ? 'stopped' : 'blocked',
    reason: reasonOf(code, stored?.message ?? 'blocked'),
  };
}

function unfinishedState(
  run: StateRow,
  stored: StateReason | null,
  facts: StateFacts,
): { state: RunState; reason: StateReason | null } {
  if (facts.queued) return { state: 'queued', reason: null };
  if (
    stored &&
    (stored.code === ERROR_CODES.RUNTIME_LIMIT ||
      stored.code === ERROR_CODES.GIT_AUTH ||
      stored.code === REASON.stalled ||
      stored.code === ERROR_CODES.HOST_UNAVAILABLE ||
      stored.code === ERROR_CODES.CI_NOT_STARTED ||
      stored.code === ERROR_CODES.DOCKER_UNAVAILABLE ||
      stored.code === REASON.asksPlanner ||
      stored.code === REASON.sameInput ||
      stored.code === REASON.waitsForMain ||
      SUBTASK_WAIT_CODES.includes(stored.code as ErrorCode))
  )
    return { state: 'waiting', reason: stored };
  if (facts.needsAnswers) return { state: 'waiting', reason: reasonOf('NEEDS_ANSWERS', 'waiting for a person') };
  if (facts.asksPlanner)
    return { state: 'waiting', reason: reasonOf(REASON.asksPlanner, 'waiting for the backlog planner') };
  if (isReturned(run)) return { state: 'idle', reason: reasonOf(REASON.returned, 'returned to implement') };
  return { state: 'idle', reason: null };
}

/** Today's facts to the honest state. The only place that maps `status` and the facts to a state. */
function deriveState(run: StateRow, facts: StateFacts = {}): { state: RunState; reason: StateReason | null } {
  const stored = readReason(run.stateReason);
  if (stored?.code === REASON.skipped) return { state: 'skipped', reason: stored };
  switch (run.status) {
    case 'running':
      if (facts.recovering) return { state: 'recovering', reason: stored };
      if (facts.stopping) return { state: 'stopping', reason: null };
      return { state: 'running', reason: facts.startWait ?? null };
    case 'done': {
      const outcome = readOutcome(run.mergeOutcome);
      return { state: outcome ? ('merged' in outcome ? 'merged' : 'closed') : 'done', reason: stored };
    }
    case 'blocked':
      return blockedState(stored);
    case 'failed':
      return stored?.code === REASON.stopped
        ? { state: 'stopped', reason: stored }
        : { state: 'failed', reason: stored };
    default:
      return unfinishedState(run, stored, facts);
  }
}

type StoredRow = StateRow & Partial<Pick<RunEntity, 'state'>>;

/** The state of the run as its row stores it. A row with no state is idle with no reason. */
export function storedState(run: StoredRow): { state: RunState; reason: StateReason | null } {
  return run.state
    ? { state: run.state as RunState, reason: readReason(run.stateReason) }
    : { state: 'idle', reason: null };
}

/** What a run view knows beyond the row: a request in flight. */
export interface LiveFacts {
  queued?: boolean;
  stopping?: boolean;
}

/**
 * The stored state with the live facts a request or the process adds. Without any, it is the stored state, except that
 * a run which waits for the container of a dead owner shows as running, as the run page and the list always showed it.
 */
export function liveState(run: StoredRow, live: LiveFacts): { state: RunState; reason: StateReason | null } {
  const held = storedState(run);
  const stored = held.state === 'recovering' ? { state: 'running' as const, reason: null } : held;
  if (live.queued && (stored.state === 'idle' || stored.state === 'waiting')) return { state: 'queued', reason: null };
  if (stored.state !== 'running') return stored;
  return live.stopping ? { state: 'stopping', reason: null } : stored;
}

/** The state columns a run's agent start wait is stored in. */
export type StartWaitColumns = Pick<RunEntity, 'state' | 'stateReason'>;

/** The state columns of a running run whose agent start waits for `wait`, or waits for nothing. Persist with `recordStartWait`. */
export function startWaitColumns(wait: StateReason | null): StartWaitColumns {
  const derived = deriveState({ status: 'running' }, wait ? { startWait: wait } : {});
  return { state: derived.state, stateReason: derived.reason ? JSON.stringify(derived.reason) : null };
}

/** The state columns of `columns` that the row `seen` does not show yet: nothing when it shows them all. */
export function unseenStartWait(seen: StartWaitColumns, columns: StartWaitColumns): Partial<StartWaitColumns> {
  return {
    ...(seen.state === columns.state ? {} : { state: columns.state }),
    ...(seen.stateReason === columns.stateReason ? {} : { stateReason: columns.stateReason }),
  };
}

/** The state a row's status, reason and merge outcome give with no facts. */
export function stateOfStatus(
  row: Pick<RunEntity, 'status'> & { stateReason?: string | null; mergeOutcome?: string | null },
): Pick<RunEntity, 'state' | 'stateReason'> {
  const derived = deriveState(row);
  return { state: derived.state, stateReason: derived.reason ? JSON.stringify(derived.reason) : null };
}

/** The reasons the facts of the open items and the row give: any other stored reason is its writer's own. */
const FACT_REASONS: string[] = [NEEDS_ANSWERS, REASON.asksPlanner, REASON.returned];

/**
 * Whether the writer of the row stored its whole state: a running, done or failed row with a state, or a reason of
 * its own. The facts of its open items cannot change it.
 */
export function keepsWrittenState(run: Pick<RunEntity, 'status' | 'state' | 'stateReason'>): boolean {
  if (run.state !== null && WRITTEN_WHOLE.includes(run.status)) return true;
  const code = readReason(run.stateReason)?.code;
  return code !== undefined && !FACT_REASONS.includes(code);
}

/**
 * Sets the state of a run from the facts of its open items, in memory. A row that `keepsWrittenState` stays as its
 * writer stored it. Persist it with `RunOpenItems.hold`.
 */
export function writeOpenItemState(
  run: StateRow & Pick<RunEntity, 'state' | 'stateReason'>,
  facts: Pick<StateFacts, 'needsAnswers' | 'asksPlanner'>,
): void {
  if (keepsWrittenState(run)) return;
  const derived = deriveState(run, facts);
  run.state = derived.state;
  run.stateReason = derived.reason ? JSON.stringify(derived.reason) : null;
}

export interface RunStateChange {
  status: string;
  currentStep?: string;
  ownerPid?: number | null;
  ownerInstance?: string | null;
  activeAttempt?: string | null;
  reason?: StateReason | null;
  facts?: StateFacts;
  /** How the merge requests of a done run ended. Kept while the run stays done, cleared when it leaves `done`. */
  merge?: MergeOutcome;
  /** When the merge watch first saw the run done. Kept like `merge`. */
  doneAt?: string;
}

type StateColumns = Pick<
  RunEntity,
  | 'status'
  | 'currentStep'
  | 'ownerPid'
  | 'ownerInstance'
  | 'activeAttempt'
  | 'state'
  | 'stateReason'
  | 'mergeOutcome'
  | 'doneAt'
>;

/** The columns of a run row that `change` sets. Used for an insert and for a conditional update. */
export function stateColumns(
  current: Pick<StateColumns, 'currentStep' | 'ownerInstance' | 'activeAttempt'> &
    Partial<Pick<StateColumns, 'mergeOutcome' | 'doneAt'>> &
    Partial<Pick<RunEntity, 'attemptsReview' | 'attemptsPipeline' | 'attemptsChecks'>>,
  change: RunStateChange,
): StateColumns {
  const status = change.status;
  const done = status === 'done';
  const mergeOutcome = done ? (change.merge ? JSON.stringify(change.merge) : (current.mergeOutcome ?? null)) : null;
  const derived = deriveState(
    {
      status,
      currentStep: change.currentStep ?? current.currentStep,
      attemptsReview: current.attemptsReview,
      attemptsPipeline: current.attemptsPipeline,
      attemptsChecks: current.attemptsChecks,
      stateReason: change.reason ? JSON.stringify(change.reason) : null,
      mergeOutcome,
    },
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
    mergeOutcome,
    doneAt: done ? (change.doneAt ?? current.doneAt ?? null) : null,
  };
}

/** Whether the run was sent back to implement by a failed review, checks or pipeline and now waits there. */
export function isReturned(run: StateRow): boolean {
  return (
    run.status === 'waiting' &&
    run.currentStep === 'implement' &&
    ((run.attemptsReview ?? 0) > 0 || (run.attemptsPipeline ?? 0) > 0 || (run.attemptsChecks ?? 0) > 0)
  );
}

/** Moves a run to a state in memory. Persist it with `change`, `claim` or `finalize`. */
export function writeRunState(
  run: Omit<StateColumns, 'mergeOutcome' | 'doneAt'> & Partial<Pick<StateColumns, 'mergeOutcome' | 'doneAt'>>,
  change: RunStateChange,
): void {
  Object.assign(run, stateColumns(run, change));
}

/** Marks the run as an epic from `at`, in memory. Persist it with `change`. */
export function markEpic(run: Pick<RunEntity, 'epicAt'>, at: string): void {
  run.epicAt = at;
}

/** Clears the epic mark, in memory. Persist it with `change`. */
export function clearEpic(run: Pick<RunEntity, 'epicAt'>): void {
  run.epicAt = null;
}

/** The column that holds the run's title. Persist it with `RunRepository.recordTitle`. */
export function titleColumns(title: string): Pick<RunEntity, 'title'> {
  return { title };
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

/** When the run started to wait for the container of a dead owner. Null when it does not wait. */
export function recoveringSince(run: RunEntity): number | null {
  if (run.state !== 'recovering' || !run.stateReason) return null;
  const since = Date.parse((JSON.parse(run.stateReason) as { message?: string }).message ?? '');
  return Number.isFinite(since) ? since : null;
}

/** The columns a person takes over a run from `machine` with: the person, their agent lists and when. */
export function ownerColumns(
  login: string,
  agents: StoredAgents | null,
  at: string,
): Pick<RunEntity, 'startedBy' | 'agents' | 'ownerSince'> {
  return { startedBy: login, agents, ownerSince: at };
}

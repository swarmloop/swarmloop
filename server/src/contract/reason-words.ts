import { ERROR_CODES } from './error-codes';

/** Which runtime's usage limit a waiting run waits for, and when it goes on by itself. Times are UTC, ISO 8601. */
export interface LimitState {
  runtime: string;
  window?: string;
  resetsAt?: string;
  resumesAt: string;
}

export interface StateReason {
  code: string;
  message: string;
  /** Set with `RUNTIME_LIMIT`. */
  limit?: LimitState;
  /** Set with `HOST_UNAVAILABLE`, `CI_NOT_STARTED` and `DOCKER_UNAVAILABLE`: when the next automatic try happens, UTC, ISO 8601. */
  retryAt?: string;
}

/** The codes of a state reason. */
export const REASON = {
  returned: 'RETURNED',
  stopped: 'STOPPED',
  checkFailed: 'CHECK_FAILED',
  didNotFit: 'DID_NOT_FIT',
  loopLimit: 'LOOP_LIMIT',
  ciLogUnavailable: 'CI_LOG_UNAVAILABLE',
  ciNotRun: ERROR_CODES.CI_NOT_RUN,
  ciTimeout: 'CI_TIMEOUT',
  blocked: 'BLOCKED',
  recovering: 'RECOVERING',
  mergeWatchUnavailable: 'MERGE_WATCH_UNAVAILABLE',
  mergeWatchStopped: 'MERGE_WATCH_STOPPED',
  skipped: 'SKIPPED',
  stalled: 'STALLED',
  agentPlace: 'AGENT_PLACE',
  asksPlanner: 'ASKS_PLANNER',
  sameInput: 'SAME_INPUT',
} as const;

/** The reason code of a run that waits for answers. */
export const NEEDS_ANSWERS = 'NEEDS_ANSWERS';

/** Who acts next: the server (`working`), a person (`person`), nobody (`done`, `neutral`), or a fault (`error`). */
export type StateTone = 'working' | 'person' | 'error' | 'done' | 'neutral';

export type StateIcon =
  | 'working'
  | 'person'
  | 'paused'
  | 'retrying'
  | 'subtasks'
  | 'queued'
  | 'pending'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'ready'
  | 'merged'
  | 'closed'
  | 'skipped';

/** What a person reads of one state: the word, who acts next and the icon. */
export interface WordShape {
  word: string;
  tone: StateTone;
  icon: StateIcon;
}

/** The word of a waiting run that waits for a person. */
export const WAITING_FOR_YOU: WordShape = { word: 'Waiting for you', tone: 'person', icon: 'person' };

/** What a reason does to the word of a waiting run: `state` leaves the state's own word. */
type ReasonKind = 'paused' | 'retrying' | 'subtasks' | 'place' | 'planner' | 'state';

type ReasonCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES] | (typeof REASON)[keyof typeof REASON] | typeof NEEDS_ANSWERS;

/** Every reason code is written out here: a new code fails to compile until someone picks its word. */
export const REASON_WORDS: Readonly<Record<ReasonCode, ReasonKind>> = {
  [ERROR_CODES.RUN_BUSY]: 'state',
  [ERROR_CODES.REVISION_CONFLICT]: 'state',
  [ERROR_CODES.RESOURCE_UNKNOWN]: 'state',
  [ERROR_CODES.CHECK_FAILED]: 'state',
  [ERROR_CODES.SESSION_INCOMPATIBLE]: 'state',
  [ERROR_CODES.REBASE_CONFLICT]: 'state',
  [ERROR_CODES.DISK_LOW]: 'state',
  [ERROR_CODES.WORKSPACE_LOST]: 'state',
  [ERROR_CODES.RUNTIME_LIMIT]: 'paused',
  [ERROR_CODES.GIT_AUTH]: 'state',
  [ERROR_CODES.BRANCH_IN_USE]: 'state',
  [ERROR_CODES.BRANCH_DIVERGED]: 'state',
  [ERROR_CODES.AGENT_ENDED_EARLY]: 'state',
  [ERROR_CODES.AGENT_LOOPING]: 'state',
  [ERROR_CODES.STEP_FAILED]: 'state',
  [ERROR_CODES.INPUT_MISSING]: 'state',
  [ERROR_CODES.DOCKER_UNAVAILABLE]: 'retrying',
  [ERROR_CODES.IMAGE_MISSING]: 'state',
  [ERROR_CODES.SUBTASKS_RUNNING]: 'subtasks',
  [ERROR_CODES.SUBTASK_WAITING]: 'subtasks',
  [ERROR_CODES.SUBTASK_BLOCKED]: 'state',
  [ERROR_CODES.PARENT_TREE_CONFLICT]: 'state',
  [ERROR_CODES.HOST_UNAVAILABLE]: 'retrying',
  [ERROR_CODES.CI_NOT_STARTED]: 'retrying',
  [ERROR_CODES.CI_NOT_RUN]: 'state',
  [ERROR_CODES.PIPELINE_UNFIXED]: 'state',
  [ERROR_CODES.SPEND_LIMIT]: 'state',
  [ERROR_CODES.TEST_FLAKY]: 'state',
  [ERROR_CODES.GIT_RULES]: 'state',
  [REASON.returned]: 'state',
  [REASON.stopped]: 'state',
  [REASON.didNotFit]: 'state',
  [REASON.loopLimit]: 'state',
  [REASON.ciLogUnavailable]: 'state',
  [REASON.ciTimeout]: 'state',
  [REASON.blocked]: 'state',
  [REASON.recovering]: 'state',
  [REASON.mergeWatchUnavailable]: 'state',
  [REASON.mergeWatchStopped]: 'state',
  [REASON.skipped]: 'state',
  [REASON.stalled]: 'state',
  [REASON.agentPlace]: 'place',
  [REASON.asksPlanner]: 'planner',
  [REASON.sameInput]: 'planner',
  [NEEDS_ANSWERS]: 'state',
};

export function kindOf(code: string): ReasonKind {
  return (REASON_WORDS as Readonly<Record<string, ReasonKind | undefined>>)[code] ?? 'state';
}

/** A run whose agent waits for a free place reads what the gate says: the reason carries the words. */
function placeWord(reason: StateReason | null): WordShape {
  return { word: reason?.message ?? '', tone: 'working', icon: 'queued' };
}

export function waitingWord(reason: StateReason | null, time: (iso: string) => string): WordShape {
  const kind = reason ? kindOf(reason.code) : 'state';
  const at = kind === 'paused' ? reason?.limit?.resumesAt : reason?.retryAt;
  switch (kind) {
    case 'paused':
      return { word: at ? `Paused until ${time(at)}` : 'Paused', tone: 'working', icon: 'paused' };
    case 'retrying':
      return { word: at ? `Retrying at ${time(at)}` : 'Retrying', tone: 'working', icon: 'retrying' };
    case 'subtasks':
      return { word: 'Waiting for subtasks', tone: 'working', icon: 'subtasks' };
    case 'place':
      return placeWord(reason);
    case 'planner':
      return { word: 'Waiting for the planner', tone: 'working', icon: 'working' };
    case 'state':
      return WAITING_FOR_YOU;
  }
}

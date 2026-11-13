import type { ErrorCode } from './error-codes';
import { ERROR_CODES, IMAGE_ERROR_CODES, SUBTASK_WAIT_CODES } from './error-codes';

/** The honest state of a run, next to the older `status`. */
export const RUN_STATES = [
  'idle',
  'queued',
  'running',
  'waiting',
  'stopping',
  'stopped',
  'recovering',
  'blocked',
  'failed',
  'done',
  'merged',
  'closed',
  'skipped',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** What a person may ask of a run in its state. The server decides, the dashboard follows. */
export type RunAction = 'resume' | 'replay' | 'rebase' | 'stop' | 'answer';

/** Which runtime's usage limit a waiting run waits for, and when it goes on by itself. Times are UTC, ISO 8601. */
export interface LimitState {
  runtime: string;
  window?: string;
  resetsAt?: string;
  resumesAt: string;
}

/** Where one repository's merge request was merged, by whom and when. */
export interface MergedFact {
  sha: string | null;
  by: string | null;
  at: string;
  /** The page of the merge commit on the host, when it can be told from the request's url. */
  url: string | null;
}

/** How a done run's merge requests ended: all merged (by repository), or one closed without a merge. */
export type MergeOutcome =
  { merged: Record<string, MergedFact> } | { closed: { repo: string; by: string | null; at: string } };

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
} as const;

/** What every command on a skipped task's run is refused with. */
export const SKIPPED_NOTE = 'this task was skipped';

/** What a stopped step says. It also tells a stopped block from the others when only the error text is known. */
export const STOP_NOTE = 'Stopped by request. Commits, pushes and merge requests stay: Stop is not a rollback.';

/** True for the text a stopped step ends with. */
export function isStopNote(text: string): boolean {
  return text.includes(STOP_NOTE);
}

const RESUMABLE_BLOCKS: readonly string[] = [
  REASON.checkFailed,
  REASON.didNotFit,
  REASON.loopLimit,
  REASON.stopped,
  REASON.ciLogUnavailable,
  REASON.ciNotRun,
  REASON.ciTimeout,
  ERROR_CODES.SPEND_LIMIT,
  ERROR_CODES.PIPELINE_UNFIXED,
  ERROR_CODES.DISK_LOW,
  ERROR_CODES.TEST_FLAKY,
  ERROR_CODES.WORKSPACE_LOST,
  ERROR_CODES.BRANCH_IN_USE,
  ERROR_CODES.BRANCH_DIVERGED,
  ERROR_CODES.SUBTASK_BLOCKED,
  ...IMAGE_ERROR_CODES,
];

/** The reason codes that need a person, each with the action that clears it. */
export const NEEDS_PERSON: Readonly<Record<string, RunAction>> = {
  NEEDS_ANSWERS: 'answer',
  [ERROR_CODES.GIT_AUTH]: 'resume',
  [ERROR_CODES.IMAGE_MISSING]: 'resume',
  [ERROR_CODES.WORKSPACE_LOST]: 'resume',
  [ERROR_CODES.BRANCH_IN_USE]: 'resume',
  [ERROR_CODES.BRANCH_DIVERGED]: 'resume',
  [ERROR_CODES.REBASE_CONFLICT]: 'rebase',
  [REASON.stopped]: 'resume',
  [REASON.loopLimit]: 'resume',
  [ERROR_CODES.SPEND_LIMIT]: 'resume',
  [REASON.checkFailed]: 'resume',
  [REASON.didNotFit]: 'resume',
  [REASON.ciNotRun]: 'resume',
  [REASON.ciLogUnavailable]: 'resume',
  [REASON.ciTimeout]: 'resume',
  [ERROR_CODES.PIPELINE_UNFIXED]: 'resume',
  [ERROR_CODES.SUBTASK_BLOCKED]: 'resume',
  [ERROR_CODES.DISK_LOW]: 'resume',
  [ERROR_CODES.TEST_FLAKY]: 'resume',
  [ERROR_CODES.INPUT_MISSING]: 'replay',
  [ERROR_CODES.RESOURCE_UNKNOWN]: 'replay',
  [REASON.blocked]: 'replay',
  [ERROR_CODES.STEP_FAILED]: 'resume',
};

/** The waiting reason codes that end by themselves: the run tries again without a person. */
export const AUTO_RETRY_CODES: readonly string[] = [
  ERROR_CODES.RUNTIME_LIMIT,
  ERROR_CODES.HOST_UNAVAILABLE,
  ERROR_CODES.CI_NOT_STARTED,
  ERROR_CODES.DOCKER_UNAVAILABLE,
  ERROR_CODES.SUBTASKS_RUNNING,
  ERROR_CODES.SUBTASK_WAITING,
];

/** The waiting codes whose next try is timed: a person may try now. */
export const TIMED_RETRY_CODES: readonly string[] = [
  ERROR_CODES.HOST_UNAVAILABLE,
  ERROR_CODES.CI_NOT_STARTED,
  ERROR_CODES.DOCKER_UNAVAILABLE,
];

/** The one place that says which actions a state allows. Availability follows what the dashboard offered before. */
export function actionsFor(state: RunState, reasonCode: string | null = null): RunAction[] {
  switch (state) {
    case 'idle':
    case 'failed':
    case 'stopped':
      return ['resume', 'replay', 'rebase'];
    case 'waiting':
      if (reasonCode === ERROR_CODES.RUNTIME_LIMIT || reasonCode === ERROR_CODES.GIT_AUTH) {
        return ['resume', 'replay', 'rebase'];
      }
      if (reasonCode && TIMED_RETRY_CODES.includes(reasonCode)) return ['stop', 'resume', 'replay', 'rebase'];
      return reasonCode && SUBTASK_WAIT_CODES.includes(reasonCode as ErrorCode)
        ? ['stop', 'resume', 'replay', 'rebase']
        : ['answer', 'replay', 'rebase'];
    case 'running':
      return ['stop', 'replay'];
    case 'stopping':
      return ['stop'];
    case 'blocked':
      return reasonCode && RESUMABLE_BLOCKS.includes(reasonCode) ? ['resume', 'replay'] : ['replay'];
    case 'done':
      return ['replay', 'rebase'];
    case 'merged':
    case 'skipped':
      return [];
    case 'closed':
      return ['replay'];
    case 'queued':
    case 'recovering':
      return [];
  }
}

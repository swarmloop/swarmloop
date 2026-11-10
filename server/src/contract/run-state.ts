import { ERROR_CODES, IMAGE_ERROR_CODES } from './error-codes';

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

export interface StateReason {
  code: string;
  message: string;
  /** Set with `RUNTIME_LIMIT`. */
  limit?: LimitState;
}

/** The codes of a state reason. */
export const REASON = {
  returned: 'RETURNED',
  stopped: 'STOPPED',
  checkFailed: 'CHECK_FAILED',
  didNotFit: 'DID_NOT_FIT',
  loopLimit: 'LOOP_LIMIT',
  ciLogUnavailable: 'CI_LOG_UNAVAILABLE',
  ciNotRun: 'CI_NOT_RUN',
  ciTimeout: 'CI_TIMEOUT',
  blocked: 'BLOCKED',
  recovering: 'RECOVERING',
} as const;

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
  ERROR_CODES.DISK_LOW,
  ERROR_CODES.WORKSPACE_LOST,
  ERROR_CODES.BRANCH_IN_USE,
  ERROR_CODES.BRANCH_DIVERGED,
  ...IMAGE_ERROR_CODES,
];

/** The one place that says which actions a state allows. Availability follows what the dashboard offered before. */
export function actionsFor(state: RunState, reasonCode: string | null = null): RunAction[] {
  switch (state) {
    case 'idle':
    case 'failed':
    case 'stopped':
      return ['resume', 'replay', 'rebase'];
    case 'waiting':
      return reasonCode === ERROR_CODES.RUNTIME_LIMIT ? ['resume', 'replay', 'rebase'] : ['answer', 'replay', 'rebase'];
    case 'running':
      return ['stop', 'replay'];
    case 'stopping':
      return ['stop'];
    case 'blocked':
      return reasonCode && RESUMABLE_BLOCKS.includes(reasonCode) ? ['resume', 'replay'] : ['replay'];
    case 'done':
      return ['replay', 'rebase'];
    case 'queued':
    case 'recovering':
      return [];
  }
}

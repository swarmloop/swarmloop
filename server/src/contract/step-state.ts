import { ERROR_CODES } from './error-codes';
import type { StateReason, StateTone } from './run-state';

/** The icon of a step card. */
export type StepIcon = 'working' | 'done' | 'failed' | 'skipped' | 'idle' | 'preparing' | 'paused' | 'returned';

/** What a person reads of one step: a word, who acts next (the color) and the icon. Never `waiting`. */
export interface StepState {
  word: string;
  tone: StateTone;
  icon: StepIcon;
}

const WORKING: StepState = { word: 'Working', tone: 'working', icon: 'working' };
const IDLE: StepState = { word: 'Not started', tone: 'neutral', icon: 'idle' };
const FAILED: StepState = { word: 'Failed', tone: 'error', icon: 'failed' };

const BY_STATUS: Readonly<Record<string, StepState>> = {
  running: WORKING,
  preparing: { word: 'Preparing', tone: 'working', icon: 'preparing' },
  done: { word: 'Done', tone: 'done', icon: 'done' },
  returned: { word: 'Returned', tone: 'error', icon: 'returned' },
  failed: FAILED,
  blocked: FAILED,
  skipped: { word: 'Skipped', tone: 'neutral', icon: 'skipped' },
};

/** The state of a step card from its status and, for the current step, the run's reason. A step that waits is paused by a limit or idle. */
export function stepState(status: string, reason: StateReason | null): StepState {
  if (status === 'waiting') {
    return reason?.code === ERROR_CODES.RUNTIME_LIMIT ? { word: 'Paused', tone: 'working', icon: 'paused' } : IDLE;
  }
  return BY_STATUS[status] ?? IDLE;
}

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

export interface StateReason {
  code: string;
  message: string;
}

/** The codes of a state reason. */
export const REASON = {
  returned: 'RETURNED',
  stopped: 'STOPPED',
  checkFailed: 'CHECK_FAILED',
  didNotFit: 'DID_NOT_FIT',
  loopLimit: 'LOOP_LIMIT',
  blocked: 'BLOCKED',
} as const;

const RESUMABLE_BLOCKS: readonly string[] = [REASON.checkFailed, REASON.didNotFit, REASON.loopLimit];

/** The one place that says which actions a state allows. Availability follows what the dashboard offered before. */
export function actionsFor(state: RunState, reasonCode: string | null = null): RunAction[] {
  switch (state) {
    case 'idle':
    case 'failed':
    case 'stopped':
      return ['resume', 'replay', 'rebase'];
    case 'waiting':
      return ['answer', 'replay', 'rebase'];
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

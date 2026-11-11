import type { RunState } from './run-state';

export const COMMAND_TYPES = [
  'start',
  'resume',
  'replay',
  'rebase',
  'answer',
  'stop',
  'step',
  'chat',
  'shell',
  'rewind',
  'remove',
  'skip',
  'projects',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export type CommandState = 'accepted' | 'executing' | 'succeeded' | 'failed' | 'superseded';

/** What a mutating route adds to the body it returned before. */
export interface CommandReceipt {
  commandId: string;
  revision: number;
  state: RunState;
}

/** The optional inputs every mutating route takes next to its own body. */
export interface CommandInput {
  expectedRevision?: number;
}

import type { RunState } from './run-state';

export const COMMAND_TYPES = [
  'start',
  'resume',
  'replay',
  'rebase',
  'answer',
  'plan-chat',
  'stop',
  'step',
  'remove',
  'skip',
  'projects',
  'create-repository',
  'remote-refresh',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export type CommandState = 'accepted' | 'executing' | 'succeeded' | 'failed' | 'superseded';

/** What a mutating route adds to the body it returned before. */
export interface CommandReceipt {
  commandId: string;
  revision: number;
  state: RunState;
}

/** What a route answers when it stores a command and does not wait for it. */
export interface CommandAccepted {
  commandId: string;
}

/** A command as its actor reads it: where it stands, what it returned or why it failed. */
export interface CommandView {
  commandId: string;
  type: CommandType;
  state: CommandState;
  value: unknown;
  error: { message: string; retryAt?: string } | null;
}

/** The optional inputs every mutating route takes next to its own body. */
export interface CommandInput {
  expectedRevision?: number;
}

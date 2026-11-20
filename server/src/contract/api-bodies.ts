import type { CommandInput } from './command';

export interface TicketKeysBody {
  prompt: string;
  key?: string;
}

export interface TicketKeysView {
  keys: string[];
}

export interface CreateRunBody extends CommandInput {
  key?: string;
  prompt?: string;
  path?: string;
  projects?: string[];
  phases?: string[];
  /** May the planner split the run into subtasks. The server's `SPLIT` decides when it is missing. */
  split?: boolean;
  /** Ids of uploaded files (`POST /uploads`) the run's agents read. */
  attachments?: string[];
}

export interface StartStepBody extends CommandInput {
  prompt?: string;
  path?: string;
}

export interface ReplayBody extends CommandInput {
  prompt?: string;
  phases?: string[];
  /** Ids of uploaded files (`POST /uploads`) the run's agents read. */
  attachments?: string[];
}

export interface ResumeBody extends CommandInput {
  prompt?: string;
}

export interface AnswersBody extends CommandInput {
  answers?: { kind?: string; id?: string; body?: string }[];
}

export interface AddProjectBody extends CommandInput {
  name?: string;
}

export interface ChatBody extends CommandInput {
  prompt?: string;
  skill?: string;
  cwd?: string;
  mcpServers?: unknown;
}

export interface OpenShellBody extends CommandInput {
  path?: string;
}

export interface LockShellBody extends CommandInput {
  container?: string;
  userId?: number;
}

export interface RewindBody extends CommandInput {
  id?: number;
}

export interface SkipTaskBody extends CommandInput {
  taskId?: string;
}

export interface RemovedRunView {
  key: string;
}

export interface ShellStatusView {
  status: string;
}

export interface SnapshotsView {
  snapshots: { id: number; step: string; at: string }[];
}

export interface RewindView {
  step: string;
}

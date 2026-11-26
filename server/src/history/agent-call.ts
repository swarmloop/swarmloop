import type { AgentExchangeEntity } from './agent-exchange.entity';

/** What a row of the log is: a call, a helper a call started, a keep-warm ping, or the mark where a chat's pings stopped. */
export type AgentCallKind = 'call' | 'helper' | 'ping' | 'ping-stop';

export type CallEndKind = 'done' | 'failed' | 'limit' | 'outage' | 'refused' | 'stopped' | 'timed-out';

export type PingStopReason = 'run-closed' | 'person-stopped' | 'cap-reached' | 'epic-merged' | 'ping-failed';

/** A row as it is stored. */
export type AgentCallRow = AgentExchangeEntity;

/** What one model used in a call, and what it cost at its prices. */
export interface ModelUsage {
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
}

/** A model's prices in USD per million tokens, by kind of token. */
export type ModelPrice = Record<string, number>;

/** One model request of a call, with the prices it was counted at. */
export interface RequestUsage extends ModelUsage {
  price: ModelPrice;
}

/** The task, run or epic a backlog turn is tied to. `general` marks a tie made for a turn that named none. */
export interface Tie {
  task?: string;
  run?: string;
  epic?: string;
  general: boolean;
}

/** What is known when a call starts. Its cost, end and response come later. */
export interface CallStart {
  kind: Exclude<AgentCallKind, 'ping' | 'ping-stop'>;
  startedAt: string;
  parentId?: number;
  previousId?: number;
  replacesId?: number;
  runKey?: string;
  turnKey?: string;
  backlog?: string;
  taskSlug?: string;
  epicKey?: string;
  step?: string;
  plannerLevel?: 'run' | 'epic' | 'backlog';
  purpose?: string;
  startReason?: string;
  attemptId?: string;
  chatId?: string;
  resumed: boolean;
  chatIdleMin?: number;
  runtime: string;
  model: string;
  effort?: string;
  requestText: string;
}

/** A keep-warm ping due at `dueAt` on a chat. It continues the chat's `previousId` row. */
export interface PingDraft {
  startedAt: string;
  dueAt: string;
  chatId: string;
  previousId: number;
  runKey: string;
  step?: string;
  backlog?: string;
  taskSlug?: string;
  epicKey?: string;
  chatIdleMin?: number;
  runtime: string;
  model: string;
  effort?: string;
  requestText: string;
}

/** How a call ended. The CLI's own totals are kept as a cross-check, never as a cost. */
export interface CallEnd {
  endKind: CallEndKind;
  finishedAt: string;
  durationMs: number;
  responseText: string;
  chatId?: string;
  errorClass?: string;
  errorText?: string;
  exitCode?: number;
  killReason?: string;
  limitWindow?: string;
  limitResetsAt?: string;
  refusedReason?: string;
  stopReason?: string;
  reported?: { usd: number; tokensIn: number; tokensOut: number };
}

/** The rows a dead process left open: an attempt's, a backlog turn's, or every ping. */
export type OpenScope = { attemptId: string } | { turnKey: string } | { pings: true };

export interface CallTotals {
  usd: number;
  tokens: number;
}

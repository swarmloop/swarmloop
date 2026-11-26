/** What a totals query groups the log by. */
export type CallTotalsBy = 'task' | 'epic' | 'step' | 'level' | 'backlog';

/** The sums of the rows of one key. `part` is a part run of an epic. `backlogTurns` marks the line of the backlog turns tied to the key. */
export interface CallTotalsLine {
  key: string;
  part: string | null;
  backlogTurns: boolean;
  usd: number;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface CallTotalsView {
  by: CallTotalsBy;
  lines: CallTotalsLine[];
}

export type CallTimelineScope = 'task' | 'step' | 'epic';

export type CallTimelineKind = 'new-chat' | 'resume' | 'ping' | 'helper' | 'failover' | 'ping-stop';

/** One row of the log in the order it started. */
export interface CallTimelineEntry {
  id: number;
  startedAt: string;
  kind: CallTimelineKind;
  step: string | null;
  runtime: string | null;
  model: string | null;
  effort: string | null;
  chatId: string | null;
  end: string;
  usd: number;
  parentId: number | null;
  previousId: number | null;
  replacesId: number | null;
}

export interface CallTimelineView {
  scope: CallTimelineScope;
  key: string;
  entries: CallTimelineEntry[];
}

/** The pings of one chat, with what its calls saved less what the pings cost. */
export interface KeepWarmChat {
  chatId: string;
  pings: number;
  hits: number;
  misses: number;
  cost: number;
  saving: number;
}

export interface KeepWarmView {
  ttlMinutes: number;
  pings: number;
  hits: number;
  misses: number;
  cost: number;
  saving: number;
  chats: KeepWarmChat[];
}

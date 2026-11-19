import type { BacklogMessageView, BacklogTurnView } from '../../../contract/backlog-chat';
import type { BacklogMessageRecord, BacklogTurnRecord } from '../../../history/backlog-writers';

/** A stored message as the conversation shows it. */
export function messageView(record: BacklogMessageRecord): BacklogMessageView {
  const { id, author, kind, text, proposes, createdAt } = record;
  return { id: id as number, author, kind, text, proposes, createdAt };
}

/** A stored turn as the conversation shows it. */
export function turnView(record: BacklogTurnRecord): BacklogTurnView {
  return {
    status: record.status,
    reason: record.reason,
    nextTryAt: record.nextTryAt,
    runtime: record.runtime,
    model: record.model,
    effort: record.effort,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    usd: record.usd,
    durationMs: record.durationMs,
    startedAt: record.createdAt,
  };
}

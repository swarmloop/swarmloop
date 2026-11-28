import type { BacklogMessageView, BacklogTurnView, MessageState } from '../../../contract/backlog-chat';
import type { BacklogMessageRecord, BacklogTurnRecord } from '../../../history/backlog-writers';

/**
 * Where a person's message stands, read from the turn that holds it: `waiting` when no running turn has it (none took
 * it, or its turn failed or waits for its next try), `read` while its turn runs, `answered` once the turn's answer is
 * applied. A planner's message has no state.
 */
export function messageState(record: BacklogMessageRecord, turns: BacklogTurnRecord[]): MessageState | undefined {
  if (record.author !== 'person') return undefined;
  const status = turns.find((turn) => turn.turnKey === record.turn)?.status;
  if (status === 'running') return 'read';
  if (status === 'applied' || status === 'done') return 'answered';
  return 'waiting';
}

/** A stored message as the conversation shows it, with its state among the turns that may hold it. */
export function messageView(record: BacklogMessageRecord, turns: BacklogTurnRecord[] = []): BacklogMessageView {
  const { id, author, kind, text, proposes, offers, createdAt, attachments } = record;
  const state = messageState(record, turns);
  return {
    id: id as number,
    author,
    kind,
    text,
    proposes,
    offers,
    createdAt,
    ...(state ? { state } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
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

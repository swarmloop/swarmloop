import type { PlanChatEntry } from '@contract/plan-chat';
import type { BacklogMessageView } from '@contract/backlog-chat';

/** A backlog message in the shape the shared message bubble draws. */
export function toEntry(message: BacklogMessageView): PlanChatEntry {
  return {
    key: `message-${message.id}`,
    role: message.author,
    text: message.text,
    at: message.createdAt,
    state: 'taken',
  };
}

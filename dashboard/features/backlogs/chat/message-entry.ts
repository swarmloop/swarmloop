import type { PlanChatEntry } from '@contract/plan-chat';
import type { BacklogMessageView, MessageState } from '@contract/backlog-chat';

const STATE_WORDS: Record<MessageState, string> = { waiting: 'Waiting', read: 'Read', answered: 'Answered' };

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

/** The plain words of where a person's message stands; a planner's message has none. */
export function stateWord(message: BacklogMessageView): string | undefined {
  return message.state ? STATE_WORDS[message.state] : undefined;
}

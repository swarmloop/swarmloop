import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView, BacklogMessageView } from '@contract/backlog-chat';
import { localTime } from '../../../lib/format';
import { actionSentence } from './action-words';

type Milestone = BacklogView['milestones'][number];

export type ChatRow =
  | { type: 'older'; key: string; sentence: string }
  | { type: 'message'; key: string; message: BacklogMessageView }
  | { type: 'proposal'; key: string; message: BacklogMessageView; milestone: Milestone; first: boolean }
  | { type: 'info'; key: string; sentence: string }
  | { type: 'problem'; key: string; sentence: string; reason: string; resume: boolean }
  | { type: 'working'; key: string; startedAt: string | null };

interface Dated {
  at: string;
  row: ChatRow;
}

function messageRow(message: BacklogMessageView, view: BacklogView, first: number | undefined): ChatRow {
  const key = `message-${message.id}`;
  if (message.kind === 'info' || message.kind === 'refused' || message.kind === 'failed') {
    return { type: 'info', key, sentence: message.text };
  }
  const milestone = view.milestones.find((item) => item.number === message.proposes);
  if (message.author === 'planner' && milestone?.status === 'proposed') {
    return { type: 'proposal', key, message, milestone, first: milestone.number === first };
  }
  return { type: 'message', key, message };
}

function olderSentence(older: number): string {
  return `${older} older ${older === 1 ? 'message is' : 'messages are'} left out.`;
}

type Turn = BacklogChatView['turns'][number];

/** What a turn that waits says: why, and when the planner tries again. */
function waitingSentence(turn: Turn): string {
  return turn.nextTryAt ? `${turn.reason} The planner tries again at ${localTime(turn.nextTryAt)}.` : turn.reason;
}

function workingRow(turn: Turn): ChatRow {
  return { type: 'working', key: 'turn', startedAt: turn.startedAt ?? null };
}

function turnRow(chat: BacklogChatView, owner: boolean): ChatRow | null {
  const turn = chat.turns.at(-1);
  if (turn?.status === 'applied' && turn.nextTryAt)
    return { type: 'info', key: 'turn', sentence: waitingSentence(turn) };
  switch (turn?.status) {
    case 'failed':
      return {
        type: 'problem',
        key: 'turn',
        sentence: 'The planner could not finish its turn.',
        reason: turn.reason,
        resume: owner,
      };
    case 'waiting':
      return { type: 'info', key: 'turn', sentence: waitingSentence(turn) };
    case 'running':
      return turn.reason ? { type: 'info', key: 'turn', sentence: turn.reason } : workingRow(turn);
    case 'applied':
      return workingRow(turn);
    case 'done':
    case undefined:
      return null;
  }
}

/**
 * The rows of the backlog chat, oldest first and newest last: the messages, the person's own actions by hand, and
 * at the end the state of the last turn. A line at the top says how many older messages are left out.
 */
export function chatRows(chat: BacklogChatView, view: BacklogView, login: string | null): ChatRow[] {
  const first = view.milestones
    .filter((milestone) => milestone.status === 'proposed')
    .map((milestone) => milestone.number)
    .sort((a, b) => a - b)[0];
  const dated: Dated[] = [
    ...chat.messages.map((message) => ({ at: message.createdAt, row: messageRow(message, view, first) })),
    ...view.events
      .filter((event) => event.kind === 'action' && event.facts.via === undefined)
      .map((event, index) => ({
        at: event.at,
        row: { type: 'info' as const, key: `action-${index}`, sentence: actionSentence(view, event.facts) },
      })),
  ];
  const rows = dated.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((item) => item.row);
  const turn = turnRow(chat, login !== null && login === view.owner);
  return [
    ...(chat.older > 0 ? [{ type: 'older' as const, key: 'older', sentence: olderSentence(chat.older) }] : []),
    ...rows,
    ...(turn ? [turn] : []),
  ];
}

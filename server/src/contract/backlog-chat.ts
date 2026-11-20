import type { AttachmentRef } from './attachments';

export type MessageAuthor = 'person' | 'planner';

/** What a message is: a plain one, a line that says why the planner answered a run, an action it dropped, or a failed turn. */
export type MessageKind = 'message' | 'info' | 'refused' | 'failed';

/** A turn is `running`, then `applied` (its actions are written) and `done`, or `failed` and waiting for Resume, or `waiting` for a usage limit. */
export type TurnStatus = 'running' | 'applied' | 'done' | 'failed' | 'waiting';

/** A message of the conversation between a person and the planner of a backlog. */
export interface BacklogMessageView {
  id: number;
  author: MessageAuthor;
  kind: MessageKind;
  text: string;
  /** The number of the milestone the planner offers to run right under this message; empty for any other message. */
  proposes: number | null;
  createdAt: string;
  /** The files sent with the message. */
  attachments?: AttachmentRef[];
}

/** A turn of the planner as the conversation shows it. */
export interface BacklogTurnView {
  status: TurnStatus;
  /** Why the turn failed or waits, in plain words. */
  reason: string;
  /** When a waiting turn tries again. */
  nextTryAt: string | null;
  /** What the turn's agent used, once it launched. */
  runtime?: string;
  model?: string;
  effort?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  /** Cost in dollars. */
  usd?: number;
  durationMs?: number;
  startedAt?: string;
}

/** What `GET /backlogs/:name/messages` answers; `older` is how many earlier messages the list leaves out. */
export interface BacklogChatView {
  messages: BacklogMessageView[];
  older: number;
  turns: BacklogTurnView[];
}

/** The body of `POST /backlogs/:name/messages`. @public */
export interface PostBacklogMessageBody {
  text: string;
  /** The ids of uploaded files to keep with the message. */
  attachments?: string[];
}

/** What the live socket sends when a backlog's conversation changes. */
export interface LiveBacklog {
  backlog: string;
  message?: BacklogMessageView;
  turn?: BacklogTurnView;
}

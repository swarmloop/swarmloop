export type MessageAuthor = 'person' | 'planner';

/** A turn is `running`, then `applied` (its actions are written) and `done`, or `failed` and waiting for Resume, or `waiting` for a usage limit. */
export type TurnStatus = 'running' | 'applied' | 'done' | 'failed' | 'waiting';

/** A message of the conversation between a person and the planner of a backlog. */
export interface BacklogMessageView {
  id: number;
  author: MessageAuthor;
  text: string;
  /** The planner offers a milestone to run right under this message. */
  proposes: boolean;
  createdAt: string;
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

/** The body of `POST /backlogs/:id/messages`. @public */
export interface PostBacklogMessageBody {
  text: string;
}

/** What the live socket sends when a backlog's conversation changes. */
export interface LiveBacklog {
  backlog: string;
  message?: BacklogMessageView;
  turn?: BacklogTurnView;
}

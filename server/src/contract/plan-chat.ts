import type { AttachmentRef } from './attachments';

/** The kind of the document that holds the plan chat. */
export const PLAN_CHAT_KIND = 'plan_chat';

/** What a person's pending message waits for: the model host did not answer the planner's reply. */
export interface PlanChatWait {
  on: 'model-host';
  /** ISO time the first outage of this wait began. */
  since: string;
  /** The host's words. */
  message: string;
  /** ISO time of the next try. */
  retryAt: string;
}

/** One message of the plan chat: a person's text, or the planner's reply. */
export interface PlanChatEntry {
  /** Names the event that made it (`message-<command id>`), so a replayed command writes it once. */
  key: string;
  role: 'person' | 'planner';
  /** The login of the person who sent it. Missing for the planner and for a machine token. */
  author?: string;
  text: string;
  /** ISO time, UTC. */
  at: string;
  /** `pending` waits for the planner; `taken` was read by whoever it was for. */
  state: 'pending' | 'taken';
  /** The plan version this entry produced. Missing when the plan did not change. */
  version?: number;
  /** The files sent with the message. */
  attachments?: AttachmentRef[];
  /** What a pending person's message waits for, while the planner's reply waits for the model host. Gone once it is taken. */
  wait?: PlanChatWait;
  /**
   * `question` is a step's question to the planner; `answer` is the planner's answer to it; `escalation` is what the
   * planner could not settle and left to whoever started the run; `info` tells the parent's chat that a person
   * talked to a subtask's planner. Missing for a message and a reply.
   */
  kind?: 'question' | 'answer' | 'escalation' | 'info';
  /** The step that asked, for a `question`, its `answer` and its `escalation`. */
  from?: string;
  /** A `question` about a reviewer's finding: the planner's answer to it carries `finding` and may carry `instruction`. */
  about?: 'finding';
  /** The planner's typed decision on the reviewer's finding, for an `answer` to a question about a finding. */
  finding?: 'holds' | 'ruled-out';
  /** What implement does now, a change of the plan included, for an `answer` to a question about a finding. */
  instruction?: string;
  /** The subtask planner's reply, for an `info`. */
  reply?: string;
  /** The key of the subtask run the `info` is about. */
  link?: string;
}

/** What one change of the plan added, changed and dropped, and why. */
export interface PlanRevision {
  version: number;
  /** The person's message, an answer to a question, a merged task. */
  reason: string;
  summary: string;
  added: string[];
  changed: string[];
  dropped: string[];
  at: string;
}

/** What `POST /runs/:key/plan-chat` takes. */
export interface PlanChatBody {
  message: string;
  /** Ids of uploaded files (`POST /uploads`) sent with the message. */
  attachments?: string[];
}

/** The body of the run's `plan_chat` document. */
export interface PlanChatLog {
  entries: PlanChatEntry[];
  revisions: PlanRevision[];
}

/** What a message sent now does. `subtask` goes to the task's own planner, `epic` to the parent's planner for an ended subtask. */
export type ComposerMode = 'plan' | 'amend' | 'add-tasks' | 'reopen' | 'follow-up' | 'subtask' | 'epic';

/** An open question or paste item the person's message answers. */
export interface ConversationQuestion {
  kind: 'question' | 'paste';
  id: string;
  text: string;
  /** The answer already given, or an empty text. */
  answer: string;
  /** ISO time the question was asked. Missing when it is not known. */
  askedAt?: string;
}

/** The conversation of a run as the server fills it. */
export interface ConversationView {
  composer: ComposerMode;
  /** True while a planner turn runs. */
  replying: boolean;
  /** Set on a subtask: the run whose planner it talks to. */
  parentKey?: string;
  entries: PlanChatEntry[];
  revisions: PlanRevision[];
  questions: ConversationQuestion[];
}

/** The plan chat stored in `body`. An empty chat when it is missing or does not read. */
export function readPlanChat(body: string | null): PlanChatLog {
  try {
    const parsed = JSON.parse(body ?? '') as Partial<PlanChatLog>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      revisions: Array.isArray(parsed.revisions) ? parsed.revisions : [],
    };
  } catch {
    return { entries: [], revisions: [] };
  }
}

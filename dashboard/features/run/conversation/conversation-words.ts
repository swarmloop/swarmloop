import type { FlowView } from '@contract/api';
import { ERROR_CODES } from '@contract/error-codes';
import type { PlanChatEntry } from '@contract/plan-chat';
import { localTime } from '../../../lib/format';

/** Talk between agents, as one sentence for a person: who asked whom what, and what came back. */
export interface AgentTalk {
  key: string;
  role: 'talk';
  /** ISO time, UTC. */
  at: string;
  /** Plain words, for example `Implement` or `The subtask`. */
  who: string;
  /** Plain words, for example `the planner` or `the parent's planner`. */
  to: string;
  asked: string;
  answered?: string;
  /** True when the planner could not settle it and passed it on to the person. */
  escalated?: boolean;
}

/** What the feed shows in order: the person's messages, the planner's replies and talk between agents. */
export type FeedEntry = PlanChatEntry | AgentTalk;

export const isTalk = (entry: FeedEntry): entry is AgentTalk => entry.role === 'talk';

/** A text longer than this many lines is folded under a line that says what it is. */
const FOLD_LINES = 12;

export const isLong = (text: string): boolean => text.split('\n').length > FOLD_LINES;

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g;
const ERROR_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+: /;
const JSON_BLOCK = /```json[\s\S]*?(?:```|$)/g;

/** A line the dashboard did not build, in plain words: no error code in front of it, no ISO time in it. */
export function plainText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(ERROR_CODE, '').replace(ISO_TIME, (iso) => localTime(iso)))
    .join('\n');
}

/** What the planner says of itself while it replies: the text without its result block. */
export const spokenText = (text: string): string => text.replace(JSON_BLOCK, '').trim();

const oneLine = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');

/** `Implement asked the planner which pagination to keep; the planner answered: cursor, as in the brief.` */
export function talkSentence(talk: AgentTalk): string {
  const asked = `${talk.who} asked ${talk.to}: ${oneLine(talk.asked)}`;
  const passed = talk.escalated ? '; the planner passed it on to you' : '';
  const answer = talk.answered ? `; the answer was: ${oneLine(talk.answered)}` : '';
  return `${asked}${passed}${answer}.`;
}

/** The line of a run that waits for a usage limit, with the local time it goes on. Null for any other run. */
export function limitWaitSentence(flow: FlowView): string | null {
  const reason = flow.stateReason;
  if (reason?.code !== ERROR_CODES.RUNTIME_LIMIT || !reason.limit) {
    return null;
  }
  return `Waiting for the ${reason.limit.runtime} usage limit. The run goes on at ${localTime(reason.limit.resumesAt)}.`;
}

/** True when the run needs the person: an open question or a step that failed or is blocked. */
export const needsPerson = (flow: FlowView): boolean =>
  (flow.conversation?.questions.length ?? 0) > 0 || flow.status === 'failed' || flow.status === 'blocked';

/** Changes when the conversation gets something new: its last entry, a question or a problem. */
export function newestOf(flow: FlowView, entries: FeedEntry[]): string {
  const questions = (flow.conversation?.questions ?? []).map((item) => item.id).join(',');
  const problem = flow.status === 'failed' || flow.status === 'blocked' ? `${flow.currentStep}:${flow.updatedAt}` : '';
  return `${entries.at(-1)?.key ?? ''}|${questions}|${problem}`;
}

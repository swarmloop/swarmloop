import type { FlowItem, FlowView } from '@contract/api';
import type { PlanChatEntry, PlanRevision } from '@contract/plan-chat';
import {
  type AgentTalk,
  type FeedEntry,
  isTalk,
  limitWaitSentence,
  plainText,
  waitsForPerson,
} from './conversation-words';

/** One thing the conversation shows, with the time it happened. */
type FeedRow =
  | { type: 'message'; key: string; at: string; entry: PlanChatEntry }
  | { type: 'talk'; key: string; at: string; talk: AgentTalk }
  | { type: 'revision'; key: string; at: string; revision: PlanRevision }
  | { type: 'question'; key: string; at: string; item: FlowItem }
  | { type: 'limit'; key: string; at: string; sentence: string }
  | { type: 'info'; key: string; at: string; sentence: string }
  | { type: 'problem'; key: string; at: string }
  | { type: 'streaming'; key: string; at: string };

/** Which row goes first when two have the same time: a revision comes after the reply of its version. */
const RANK: Record<FeedRow['type'], number> = {
  message: 0,
  talk: 0,
  revision: 1,
  question: 2,
  limit: 3,
  info: 3,
  problem: 3,
  streaming: 4,
};

/** The conversation of a run as one list ordered by time, the newest last. A reply that streams is always the last. */
export function feedTimeline(flow: FlowView, entries: FeedEntry[]): FeedRow[] {
  const asked = new Map((flow.conversation?.questions ?? []).map((question) => [question.id, question.askedAt]));
  const rows: FeedRow[] = [
    ...entries.map((entry): FeedRow => {
      return isTalk(entry)
        ? { type: 'talk', key: entry.key, at: entry.at, talk: entry }
        : { type: 'message', key: entry.key, at: entry.at, entry };
    }),
    ...(flow.conversation?.revisions ?? []).map((revision): FeedRow => ({
      type: 'revision',
      key: `revision:${revision.version}`,
      at: revision.at,
      revision,
    })),
    ...flow.items.map((item): FeedRow => ({
      type: 'question',
      key: `${item.kind}:${item.id}`,
      at: asked.get(item.id) ?? flow.updatedAt,
      item,
    })),
    ...flow.returns.flatMap((edge): FeedRow[] =>
      edge.words && edge.at ? [{ type: 'info', key: `return:${edge.counter}`, at: edge.at, sentence: edge.words }] : [],
    ),
  ];
  const limit = limitWaitSentence(flow);
  if (limit) {
    rows.push({ type: 'limit', key: 'limit', at: flow.updatedAt, sentence: limit });
  }
  if (waitsForPerson(flow)) {
    rows.push({ type: 'problem', key: 'problem', at: flow.updatedAt });
  } else if (flow.status === 'waiting' && !limit && flow.actions.includes('resume')) {
    rows.push({ type: 'info', key: 'info', at: flow.updatedAt, sentence: plainText(flow.sentence) });
  }
  const order = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) =>
      a.row.at < b.row.at ? -1 : a.row.at > b.row.at ? 1 : RANK[a.row.type] - RANK[b.row.type] || a.index - b.index,
    )
    .map(({ row }) => row);
  return flow.conversation?.replying ? [...order, { type: 'streaming', key: 'streaming', at: flow.updatedAt }] : order;
}

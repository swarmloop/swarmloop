import type { PlanChatEntry } from '@contract/plan-chat';
import type { FeedEntry } from './conversation-words';

/** A step as it is named in a sentence: `Implement`, `Implement improve`, `The quality reviewer`, `The subtask`. */
function askerName(from: string | undefined): string {
  if (!from) return 'A step';
  if (from.startsWith('subtask:')) return 'The subtask';
  if (from.startsWith('code-review-')) return `The ${from.slice('code-review-'.length)} reviewer`;
  const words = from.replace(/-/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * What the feed shows of the stored plan chat: a step's question, the planner's answer to it and an escalation of it
 * become one line of talk between agents; the person's messages and the planner's replies stay as they are. An answer
 * is named by the question it belongs to (`answer-<question key>`), as an escalation is (`escalate-<question key>`).
 */
export function feedEntries(entries: readonly PlanChatEntry[], parentKey?: string): FeedEntry[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const to = parentKey ? "the parent's planner" : 'the planner';
  const joined = (entry: PlanChatEntry): boolean =>
    (entry.kind === 'answer' || entry.kind === 'escalation') &&
    byKey.get(entry.key.replace(/^(answer|escalate)-/, ''))?.kind === 'question';
  const feed: FeedEntry[] = [];
  for (const entry of entries) {
    if (joined(entry)) continue;
    if (entry.kind === 'question') {
      const answer = byKey.get(`answer-${entry.key}`);
      feed.push({
        key: entry.key,
        role: 'talk',
        at: entry.at,
        who: askerName(entry.from),
        to,
        asked: entry.text,
        ...(answer ? { answered: answer.text } : {}),
        ...(byKey.has(`escalate-${entry.key}`) ? { escalated: true } : {}),
      });
    } else if (entry.kind === 'escalation') {
      feed.push({ key: entry.key, role: 'talk', at: entry.at, who: 'The planner', to: 'you', asked: entry.text });
    } else {
      feed.push(entry);
    }
  }
  return feed;
}

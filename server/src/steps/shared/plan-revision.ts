import type { PlanRevision } from '../../contract/plan-chat';

interface RevisionInput {
  /** The plan items before and after the change. */
  before: readonly string[];
  after: readonly string[];
  /** The person's message, an answer to a question, a merged task. */
  reason: string;
  /** The revisions already stored. */
  known: readonly PlanRevision[];
  at: string;
}

const countOf = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`;

/**
 * What a plan change added, changed and dropped. An item no longer in the plan is paired with an item new in it, in
 * order, as one that changed; the rest is added or dropped. The first plan is version 1, so a revision is 2 or more.
 */
export function buildRevision(input: RevisionInput): PlanRevision {
  const gone = input.before.filter((item) => !input.after.includes(item));
  const fresh = input.after.filter((item) => !input.before.includes(item));
  const paired = Math.min(gone.length, fresh.length);
  const added = fresh.slice(paired);
  const dropped = gone.slice(paired);
  const changed = fresh.slice(0, paired);
  const parts = [
    ...(added.length > 0 ? [`added ${countOf(added.length)}`] : []),
    ...(changed.length > 0 ? [`changed ${countOf(changed.length)}`] : []),
    ...(dropped.length > 0 ? [`dropped ${countOf(dropped.length)}`] : []),
  ];
  const text = parts.length > 0 ? parts.join(', ') : 'reordered the items';
  return {
    version: Math.max(1, ...input.known.map((revision) => revision.version)) + 1,
    reason: input.reason,
    summary: `${text[0].toUpperCase()}${text.slice(1)}`,
    added,
    changed,
    dropped,
    at: input.at,
  };
}

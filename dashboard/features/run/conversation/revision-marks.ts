import { createContext } from 'react';
import type { PlanRevision } from '@contract/plan-chat';

/** The latest plan change, for the plan checklist wherever it is drawn. Null draws it plain. */
export const PlanRevisionContext = createContext<PlanRevision | null>(null);

/** What the latest revision did to an item. */
export type RevisionMark = 'added' | 'changed';

/** The revision with the highest version, or null for a run whose plan never changed. */
export function latestRevision(revisions: PlanRevision[] | undefined): PlanRevision | null {
  return (revisions ?? []).reduce<PlanRevision | null>(
    (latest, item) => (latest === null || item.version > latest.version ? item : latest),
    null,
  );
}

const MARKER = /^\s*(?:[-*+]|\d+[.)]|#+)?\s*/;

/** Whether `item` (a whole plan item) and `text` (a line or a title) name the same thing: one holds the other. */
const names = (item: string, text: string): boolean => {
  const bare = text.replace(MARKER, '').trim();
  return item !== '' && bare !== '' && (text.includes(item) || item.includes(bare));
};

/** Whether the revision added or changed an item that `text` is, or is part of. */
export function markOf(revision: PlanRevision | null, text: string): RevisionMark | null {
  if (revision?.added.some((item) => names(item, text))) {
    return 'added';
  }
  return revision?.changed.some((item) => names(item, text)) ? 'changed' : null;
}

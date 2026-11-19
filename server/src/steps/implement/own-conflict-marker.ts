/** Tells the conflict of a parent's own edits from a person's Rebase, which stores a bare `pending`. */
const OWN_EDITS_TAG = 'parent-own-edits';

/** The `rebaseConflict` body that hands the parent's own conflict to the implement agent. */
export function ownConflictMarker(conflict: string): string {
  return `pending\n${OWN_EDITS_TAG}\n${conflict}\n`;
}

/** The conflict text of a marker body (the lines after `pending`) that ownConflictMarker wrote, else null. */
export function ownConflictOf(rest: string): string | null {
  const [tag, ...conflict] = rest.split('\n');
  return tag?.trim() === OWN_EDITS_TAG ? conflict.join('\n').trim() : null;
}

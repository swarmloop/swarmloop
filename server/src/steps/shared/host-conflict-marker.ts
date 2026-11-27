/** Tells a conflict only the code host sees from a person's Rebase (a bare `pending`) and a parent's own edits. */
const HOST_CONFLICT_TAG = 'host-conflict';

/** The `rebaseConflict` body that hands the code host's conflict text to the implement agent. */
export function hostConflictMarker(text: string): string {
  return `pending\n${HOST_CONFLICT_TAG}\n${text}\n`;
}

/** The conflict text of a marker body (the lines after `pending`) that hostConflictMarker wrote, else null. */
export function hostConflictOf(rest: string): string | null {
  const [tag, ...text] = rest.split('\n');
  return tag?.trim() === HOST_CONFLICT_TAG ? text.join('\n').trim() : null;
}

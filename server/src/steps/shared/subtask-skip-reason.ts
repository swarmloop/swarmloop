/** The reason of a subtask run closed because its epic ended without a merge. */
export const EPIC_CLOSED_NOTE = 'the epic was closed';

/** The reason of a subtask run its epic marked skipped, with the epic's own words, or `nothing left to do` without. */
export function skippedByEpic(note?: string): string {
  return `skipped by its epic: ${note?.trim() || 'nothing left to do'}`;
}

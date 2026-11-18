import { wordList } from '../../core/word-list';
import type { Opinion } from './code-review-record';

/** One `kind decision` line per opinion, as the code-review visit's line shows the round. */
export function opinionSummary(opinions: Opinion[]): string {
  return opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
}

/** The line of a one-reviewer round that leaves others open: who they are, and why the report waits. */
export function othersOpenLine(open: { missing: string[]; returned: string[] }): string {
  const parts = [
    ...(open.missing.length > 0
      ? [`${wordList(open.missing)} ${open.missing.length === 1 ? 'has' : 'have'} no answer for these files`]
      : []),
    ...(open.returned.length > 0 ? [`${wordList(open.returned)} returned`] : []),
  ];
  return `code-review waiting: ${parts.join(', ')}; the report waits for them`;
}

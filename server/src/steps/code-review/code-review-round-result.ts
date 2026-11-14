import type { Opinion } from './code-review-record';

/** One `kind decision` line per opinion, as the code-review visit's line shows the round. */
export function opinionSummary(opinions: Opinion[]): string {
  return opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
}

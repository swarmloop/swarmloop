// remove after runs started before f52 are gone
import type { ReviewResult } from '../definitions/review';
import { legacyItems, legacySection } from './prose-lines';

const DECISION = /^[`*\s]*decision:\s*(ok|return)\b/i;

/** The decision, the body and the summary list of a rendered `review_<name>` document. Null when it names no decision. */
export function legacyReview(body: string): ReviewResult | null {
  const lines = body.split(/\r?\n/);
  const decision = lines
    .map((line) => DECISION.exec(line.trim())?.[1]?.toLowerCase())
    .filter((value): value is 'ok' | 'return' => value === 'ok' || value === 'return')
    .at(-1);
  if (!decision) {
    return null;
  }
  const review = lines.filter((line) => !DECISION.test(line.trim())).join('\n');
  return { decision, review: review.trim(), summary: legacyItems(legacySection(body, 'summary') ?? '') };
}

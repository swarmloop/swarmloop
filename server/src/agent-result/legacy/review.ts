// remove after runs started before f52 are gone
import type { ReviewResult } from '../definitions/review';
import { legacyItems, legacySection } from './prose-lines';

const DECISION = /^[`*\s]*decision:\s*(ok|return)\b/i;
const MET = /^\W*(?:\d+\.\s*)?met:\s*.*\(([^()]+)\)\s*$/gim;

/** The locations an old requirements review gives for the lines it marks `met`, in its text and its summary list. */
function legacyMet(review: string, summary: string[]): string[] {
  const found = [...[review, ...summary].join('\n').matchAll(MET)].map((match) => match[1].trim());
  return [...new Set(found)];
}

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
  const summary = legacyItems(legacySection(body, 'summary') ?? '');
  return { decision, review: review.trim(), summary };
}

/** An old requirements review also gives the locations of behaviors it marks as met. */
export function legacyRequirementsReview(body: string): ReviewResult | null {
  const review = legacyReview(body);
  if (!review) {
    return null;
  }
  const met = legacyMet(review.review, review.summary);
  return { ...review, ...(met.length > 0 ? { met } : {}) };
}

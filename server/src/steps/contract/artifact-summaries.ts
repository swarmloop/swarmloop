import type { ReviewResult } from '../../agent-result/definitions/review';
import { legacyReview } from '../../agent-result/legacy/review';
import { requirementsView } from '../../contract/requirements-view';
import { firstLine, listSummary } from './artifact';

/** The title of the requirements, or the first line of a body that is not a requirements record. */
export function summarizeRequirements(body: string): string {
  return requirementsView(body)?.title || firstLine(body.replace(/^#+\s*/gm, ''));
}

/** `<n> checklist items: <first item>` of the plan inside a requirements document. */
export function summarizePlan(body: string): string | null {
  const plan = requirementsView(body)?.plan;
  return plan && plan.items.length > 0 ? listSummary(plan.items.length, 'checklist items', plan.items[0]) : null;
}

/** `pass`, or `fail: <job>` for the job the log names first. */
export function summarizePipeline(body: string): string {
  const result = /^result:\s*(\S+)/m.exec(body)?.[1] ?? '';
  if (result === 'fail') {
    const job = /^job:\s*(.+)$/m.exec(body)?.[1];
    return job ? `fail: ${job.trim()}` : 'fail';
  }
  return result === 'pass' ? 'pass' : firstLine(body);
}

/** The decision of a review and the first line of what it found. */
function reviewLine(decision: string | undefined, text: string): string {
  return [decision ? `decision: ${decision}` : '', firstLine(text)].filter(Boolean).join(' · ');
}

/** The line of a rendered review, for a run from before results were stored. */
export function summarizeReview(body: string): string {
  const review = legacyReview(body);
  return reviewLine(review?.decision, review?.review ?? body);
}

export function summarizeReviewResult(result: ReviewResult): string {
  return reviewLine(result.decision, result.review);
}

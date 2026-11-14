import type { ReviewResult } from '../../agent-result/definitions/review';
import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import type { DocumentDraft } from '../../history/visit';
import { ARTIFACTS, REVIEWS, reviewResultOf } from '../contract/artifacts';
import { textDocument } from '../shared/handoff';
import { renderReport } from '../shared/report-text';

/** What one reviewer decided: its stored result, and the document text a person and the next prompts read. */
export interface Opinion {
  kind: string;
  decision: 'ok' | 'return';
  body: string;
  result: ReviewResult;
}

/** The `review_<name>` document: the review, then the decision line. */
export function renderReview(result: ReviewResult): string {
  return `${result.review.trimEnd()}\ndecision: ${result.decision}\n`;
}

export function opinionOf(kind: string, result: ReviewResult): Opinion {
  return { kind, decision: result.decision, body: renderReview(result), result };
}

/** A repeated return is accepted: the same review, decided ok. */
export function decidedOk(opinion: Opinion): Opinion {
  return opinionOf(opinion.kind, { ...opinion.result, decision: 'ok' });
}

/** The documents a reviewer's round stores: the rendered review and the result it was rendered from. */
export function reviewDocuments(opinion: Opinion): DocumentDraft[] {
  const stored = reviewResultOf(opinion.kind.slice(REVIEWS.prefix.length));
  return [textDocument(opinion.kind, opinion.body), textDocument(stored.kind, stored.format(opinion.result))];
}

/** The documents the report stores: the rendered report and the result it was rendered from. */
export function reportDocuments(result: ReviewReportResult): DocumentDraft[] {
  return [
    textDocument(ARTIFACTS.reviewReport.kind, renderReport(result)),
    textDocument(ARTIFACTS.reviewReportResult.kind, ARTIFACTS.reviewReportResult.format(result)),
  ];
}

/** The handoff note of a review: its summary list, or its decision when it gave none. */
export function summaryNote(result: ReviewResult): string {
  const lines = result.summary.length > 0 ? result.summary : [result.decision];
  return `${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

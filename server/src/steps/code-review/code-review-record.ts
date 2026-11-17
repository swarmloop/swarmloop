import type { ReviewResult } from '../../agent-result/definitions/review';
import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import type { DocumentDraft } from '../../history/visit';
import { ARTIFACTS, REVIEWS, reviewResultOf } from '../contract/artifacts';
import { textDocument } from '../shared/handoff';
import { assumedLine } from '../implement/implement-question';

/** What one reviewer decided: its stored result, and the document text a person and the next prompts read. */
export interface Opinion {
  kind: string;
  decision: 'ok' | 'return';
  body: string;
  result: ReviewResult;
}

/** One `<id> <status>: <note>` line for each requirement mark, in id order. */
function markLines(result: ReviewResult): string {
  const number = (id: string): number => Number(id.replace(/\D/g, ''));
  const marks = [...(result.requirements ?? [])].sort(
    (a, b) => number(a.id) - number(b.id) || a.id.localeCompare(b.id),
  );
  return marks.map((mark) => `${mark.id} ${mark.status}: ${mark.note}\n`).join('');
}

/** The `review_<name>` document: the review, the requirement marks, then the decision line. */
export function renderReview(result: ReviewResult): string {
  const reason = result.reason ? `reason: ${result.reason}\n` : '';
  return `${result.review.trimEnd()}\n${markLines(result)}decision: ${result.decision}\n${reason}`;
}

export function opinionOf(kind: string, result: ReviewResult): Opinion {
  return { kind, decision: result.decision, body: renderReview(result), result };
}

/** The documents a reviewer's round stores: the rendered review and the result it was rendered from. */
export function reviewDocuments(opinion: Opinion): DocumentDraft[] {
  const stored = reviewResultOf(opinion.kind.slice(REVIEWS.prefix.length));
  return [textDocument(opinion.kind, opinion.body), textDocument(stored.kind, stored.format(opinion.result))];
}

/** The documents the report stores: the report text and the model's parts it was rendered from. */
export function reportDocuments(text: string, result: ReviewReportResult): DocumentDraft[] {
  return [
    textDocument(ARTIFACTS.reviewReport.kind, text),
    textDocument(ARTIFACTS.reviewReportResult.kind, ARTIFACTS.reviewReportResult.format(result)),
  ];
}

/** The handoff note of a review: its summary list, or its decision when it gave none. */
export function summaryNote(result: ReviewResult): string {
  const lines = result.summary.length > 0 ? result.summary : [result.decision];
  const assumed = result.question?.trim() ? [`- ${assumedLine(result.question)}`] : [];
  return `${[...lines.map((line) => `- ${line}`), ...assumed].join('\n')}\n`;
}

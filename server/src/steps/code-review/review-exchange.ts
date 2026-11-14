import type { DocumentRepository } from '../../history/document.repository';
import { storedReview } from '../../agent-result/stored-review';
import { ARTIFACTS } from '../contract/artifacts';
import { isChecksReturn } from '../follow-up';
import { reviewReturn } from '../shared/handoff';
import { REVIEWERS } from './reviewer';

/** One reviewer's last finding and what implement answered to it. */
export interface Exchange {
  finding: string;
  answer: string | null;
}

interface StoredDocument {
  kind: string;
  body: string;
}

/** The reasons implement gave since the reviewer's last review, for the findings it rejected that name the reviewer. */
function answerTo(name: string, documents: StoredDocument[], since: number): string | null {
  const reasons = documents.slice(since + 1).flatMap((document) => {
    if (document.kind === ARTIFACTS.implementationResult.kind) {
      return ARTIFACTS.implementationResult.parse(document.body).rejected ?? [];
    }
    if (document.kind === ARTIFACTS.implementationImproveResult.kind) {
      return ARTIFACTS.implementationImproveResult.parse(document.body).rejected ?? [];
    }
    return [];
  });
  const mine = reasons.filter((item) => item.reviewer === name).map((item) => item.reason.trim());
  return mine.length > 0 ? mine.join('\n') : null;
}

/**
 * After a review return, the reviewers whose last review is a return, each with that finding and the answer of implement.
 * Keyed by reviewer name. Empty when the run was not sent back by a review.
 */
export async function reviewExchanges(
  repository: DocumentRepository,
  runId: number,
  returned: string | null,
): Promise<Map<string, Exchange>> {
  const exchanges = new Map<string, Exchange>();
  if (!reviewReturn(returned) || isChecksReturn(returned)) {
    return exchanges;
  }
  const documents = await repository.listDocuments(runId);
  for (const { name, kind } of REVIEWERS) {
    const review = storedReview(name, documents);
    if (review?.decision !== 'return') {
      continue;
    }
    const since = documents.map((document) => document.kind).lastIndexOf(kind);
    exchanges.set(name, { finding: review.review.trim(), answer: answerTo(name, documents, since) });
  }
  return exchanges;
}

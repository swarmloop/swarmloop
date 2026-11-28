import { STORED_REVIEWERS } from '../../contract/steps';
import { ARTIFACTS, reviewResultOf } from '../contract/artifacts';
import { answered, openQuestions } from './answers';
import { rejectedFindings } from './rejected-findings';
import { askedReviewer } from './reviewer-labels';
import { readStored } from './report-stored';

/** One finding implement did not fix: its reason, what the reviewer answered, and what the person decided. */
export interface ReportExchange {
  finding: string;
  reason: string;
  answer: string | null;
  decision: string | null;
}

interface StoredDocument {
  kind: string;
  body: string;
}

/** The unfixed findings still open at the end of the run's documents, keyed by reviewer name. */
export function reportExchanges(documents: StoredDocument[]): Map<string, ReportExchange> {
  const open = new Map<string, ReportExchange>();
  for (const document of documents) {
    const rejected = readStored(() => rejectedFindings(document) ?? null);
    if (rejected) {
      open.clear();
      for (const item of rejected) {
        open.set(item.reviewer, {
          finding: item.finding.trim(),
          reason: item.reason.trim(),
          answer: null,
          decision: null,
        });
      }
    }
    const reviewer = STORED_REVIEWERS.find((name) => reviewResultOf(name).kind === document.kind);
    const exchange = reviewer ? open.get(reviewer) : undefined;
    if (reviewer && exchange) {
      const review = readStored(() => reviewResultOf(reviewer).parse(document.body));
      if (review?.decision === 'ok') {
        open.delete(reviewer);
      } else if (review?.reason) {
        exchange.answer = review.reason.trim();
      }
    }
  }
  return withDecisions(open, documents);
}

/** Adds the person's decision to each open finding the code review asked about. */
function withDecisions(open: Map<string, ReportExchange>, documents: StoredDocument[]): Map<string, ReportExchange> {
  const decisions = new Map<string, string>();
  for (const document of documents.filter((item) => item.kind === ARTIFACTS.answers.kind)) {
    answered(document.body).forEach((value, question) => decisions.set(question, value));
  }
  for (const document of documents.filter((item) => item.kind === ARTIFACTS.reviewQuestions.kind)) {
    for (const question of openQuestions(document.body, [])) {
      const reviewer = askedReviewer(question);
      const decision = decisions.get(question)?.trim();
      const exchange = reviewer ? open.get(reviewer) : undefined;
      if (exchange && decision) {
        exchange.decision = decision;
      }
    }
  }
  return open;
}

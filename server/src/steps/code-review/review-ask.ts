import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft, ExchangeDraft } from '../../history/visit';
import type { PipelineResult } from '../../core/pipeline-result';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import { withInstructions } from '../plan/plan-record';
import { renderQuestions } from '../research/research-record';
import { answered, openQuestions } from '../shared/answers';
import { issueOf, returnNotes, textDocument } from '../shared/handoff';
import type { Exchange } from './review-exchange';
import { closeReview } from './review-report';
import type { Finished, Usage } from './reviewer';

const ASKED = /^(\S+) still returns: /;

/** One line for the person: the reviewer, its finding and the answer of implement side by side. `askedAt` makes the ask its own event. */
function questionFor(reviewer: string, exchange: Exchange, askedAt: string): string {
  const line = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');
  const answer = exchange.answer?.trim() ? line(exchange.answer) : 'nothing';
  return `${reviewer} still returns: ${line(exchange.finding)} Implement answered: ${answer}. Which holds? (asked ${askedAt})`;
}

/**
 * One question per reviewer that saw an answer of implement and decided return again in this round, on a diff that did not change.
 * A kept or recovered opinion is not asked about: only a decision this round made counts.
 */
export function reviewQuestions(
  exchanges: ReadonlyMap<string, Exchange>,
  finished: Finished[],
  same: boolean,
  askedAt: string,
): string[] {
  if (!same) {
    return [];
  }
  return finished.flatMap((item) => {
    const exchange = exchanges.get(item.reviewer.name);
    return exchange && item.parsed?.decision === 'return' ? [questionFor(item.reviewer.name, exchange, askedAt)] : [];
  });
}

/** Waits for the person: the reviews as the reviewers gave them, and the questions as the document the answers close. */
export function askPerson(
  ctx: StepContext,
  questions: string[],
  documents: DocumentDraft[],
  exchanges: ExchangeDraft[],
  usage: Usage,
): Promise<PipelineResult> {
  const body = renderQuestions(questions);
  return closeReview(
    ctx,
    { to: 'wait', reason: 'questions are open' },
    `${ctx.opened.startedAt} code-review waiting\n${body}`,
    [...documents, textDocument(ARTIFACTS.reviewQuestions.kind, body)],
    exchanges,
    usage,
  );
}

/**
 * Runs first. Null when the review holds no question; otherwise the result of settling the questions it holds.
 * It reads the stored documents of the run, so a review that holds no question reads nothing but them.
 */
export async function settleAsked(ctx: StepContext, documents: DocumentRepository): Promise<PipelineResult | null> {
  const stored = await documents.listDocuments(ctx.opened.run.id);
  const latest = (kind: string): string => [...stored].reverse().find((item) => item.kind === kind)?.body ?? '';
  const asked = latest(ARTIFACTS.reviewQuestions.kind);
  if (!asked.trim()) {
    return null;
  }
  return settleAnswers(ctx, asked, latest(ARTIFACTS.answers.kind));
}

/**
 * Settles the questions of the review. With one still open it waits. When the person answered all of them, each
 * decision goes into the requirements as an instruction a person added, the questions are closed, and the run goes
 * back to implement with the finding and the decision.
 */
async function settleAnswers(ctx: StepContext, questionsBody: string, answersBody: string): Promise<PipelineResult> {
  const stored = answered(answersBody);
  const questions = openQuestions(questionsBody, []);
  if (questions.some((question) => !(stored.get(question) ?? '').trim())) {
    return closeReview(
      ctx,
      { to: 'wait', reason: 'questions are open' },
      `${ctx.opened.startedAt} code-review waiting\n${questionsBody}`,
      [],
      [],
    );
  }
  let requirements = (await ctx.reread(ARTIFACTS.requirements)) ?? '';
  const issues = questions.map((question) => {
    const decision = (stored.get(question) ?? '').trim();
    requirements = withInstructions(
      requirements,
      `A person decided on the code review: ${question} - ${decision}`,
      false,
    );
    const reviewer = ASKED.exec(question)?.[1] ?? 'code-review';
    return issueOf(reviewer, `${reviewer} returned the change`, `${question}\nThe person decided: ${decision}`);
  });
  return closeReview(
    ctx,
    { to: 'return', step: 'implement', issues },
    `${ctx.opened.startedAt} code-review waiting\n${questions.length} questions answered`,
    [
      textDocument(ARTIFACTS.requirements.kind, requirements),
      textDocument(ARTIFACTS.reviewQuestions.kind, ''),
      returnNotes(issues),
      textDocument(ARTIFACTS.issues.kind, ARTIFACTS.issues.format(issues)),
    ],
    [],
  );
}

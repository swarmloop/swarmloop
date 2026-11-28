import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft } from '../../history/visit';
import type { PipelineResult } from '../../core/pipeline-result';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import { withInstructions } from '../plan/plan-record';
import { renderQuestions } from '../research/research-record';
import { answered, openQuestions, renderAnswers } from '../shared/answers';
import { askPerson, type PersonHeld } from '../shared/person-questions';
import { reviewParts, type AnsweredQuestion, type StoredQuestion } from '../shared/question-parts';
import { askedReviewer } from '../shared/reviewer-labels';
import { issueOf, returnNotes, textDocument } from '../shared/handoff';
import type { Exchange } from './review-exchange';
import { REVIEWERS } from './reviewer';
import { opinionOf, reviewDocuments, ruledOutOpinion, type Opinion } from './code-review-record';
import { routeReview } from './review-round';
import { latestReview } from '../../agent-result/stored-review';
import type { PlanChatEntry } from '../../contract/plan-chat';
import type { EventRepository } from '../../history/event.repository';
import type { PlanChatStore } from '../../history/plan-chat.store';
import { reviewAnswerKey } from '../shared/review-answer-key';
import { closeReview, type ReportCall } from './review-report';
import type { Finished, Usage } from './reviewer';

/** One line for the person: the reviewer, its finding and the answer of implement side by side. `askedAt` makes the ask its own event. */
function questionFor(reviewer: string, exchange: Exchange, askedAt: string): string {
  const line = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');
  const answer = exchange.answer?.trim() ? line(exchange.answer) : 'nothing';
  return `${reviewer} still returns: ${line(exchange.finding)} Implement answered: ${answer}. Which holds? (asked ${askedAt})`;
}

/**
 * One ask per reviewer that saw an answer of implement and decided return again in this round, on any head.
 * A kept or recovered opinion is not asked about: only a decision this round made counts.
 */
export function reviewAsks(
  exchanges: ReadonlyMap<string, Exchange>,
  finished: Finished[],
  askedAt: string,
): StoredQuestion[] {
  return finished.flatMap((item) => {
    const exchange = exchanges.get(item.reviewer.name);
    const result = item.parsed?.decision === 'return' ? item.parsed.result : null;
    return exchange && result
      ? [
          {
            question: questionFor(item.reviewer.name, exchange, askedAt),
            parts: reviewParts(item.reviewer.name, exchange, result, askedAt),
          },
        ]
      : [];
  });
}

/** What the visit that asks keeps: the reviews it recorded, the report's call and its usage. */
interface AskCarried {
  documents: DocumentDraft[];
  call: ReportCall | null;
  usage: Usage;
}

/**
 * Puts the reviewers' questions to the person through the one writer: the reviews as the reviewers gave them, and the
 * questions as the document the answers close. A question the person answered before is not put again: its answer
 * settles the review as a person's answer does, at once when every question was answered before, and otherwise with
 * the answers it wrote for the questions that wait.
 */
export async function askReviewer(
  ctx: StepContext,
  asks: StoredQuestion[],
  answered: AnsweredQuestion[],
  carried: AskCarried,
  documents: DocumentRepository,
): Promise<PipelineResult> {
  let held: PersonHeld = { lines: [], parts: [], answered };
  const known: [string, string][] = [];
  for (const ask of asks) {
    const result = askPerson(held, ask);
    if (result.kind === 'asked') held = { ...held, lines: result.lines, parts: result.parts };
    else known.push([ask.question, result.answer]);
  }
  const body = renderQuestions(asks.map((ask) => ask.question));
  if (held.lines.length === 0) {
    return settleAnswers(ctx, { body, id: 0 }, renderAnswers(known), documents, undefined, carried);
  }
  return closeReview(
    ctx,
    { to: 'wait', reason: 'questions are open' },
    `${ctx.opened.startedAt} code-review waiting\n${body}`,
    [
      ...carried.documents,
      textDocument(ARTIFACTS.reviewQuestions.kind, body),
      textDocument(ARTIFACTS.questionParts.kind, ARTIFACTS.questionParts.format(asks)),
      ...(known.length > 0 ? [textDocument(ARTIFACTS.answers.kind, renderAnswers(known))] : []),
    ],
    carried.call,
    carried.usage,
  );
}

/**
 * Runs first. Null when the review holds no question; otherwise the result of settling the questions it holds.
 * It reads the stored documents of the run, so a review that holds no question reads nothing but them.
 */
export async function settleAsked(
  ctx: StepContext,
  documents: DocumentRepository,
  planner?: SubtaskPlanner,
): Promise<PipelineResult | null> {
  const stored = await documents.listDocuments(ctx.opened.run.id);
  const newest = (kind: string) => [...stored].reverse().find((item) => item.kind === kind);
  const latest = (kind: string): string => newest(kind)?.body ?? '';
  const asked = latest(ARTIFACTS.reviewQuestions.kind);
  if (!asked.trim()) {
    return null;
  }
  return settleAnswers(
    ctx,
    { body: asked, id: newest(ARTIFACTS.reviewQuestions.kind)?.id ?? 0 },
    latest(ARTIFACTS.answers.kind),
    documents,
    planner,
  );
}

/** What a subtask's review settles with besides the person's answers: the chat of its planner's typed answers, and the events. */
interface SubtaskPlanner {
  chat: PlanChatStore;
  events: EventRepository;
}

/** The epic planner's typed answer to these questions, when it gave one that is not taken yet. */
async function typedAnswer(key: string, askId: number, chat?: PlanChatStore): Promise<PlanChatEntry | null> {
  if (!chat) return null;
  const answerKey = reviewAnswerKey(askId);
  const { entries } = await chat.read(key);
  return entries.find((entry) => entry.key === answerKey && entry.state === 'pending' && entry.finding) ?? null;
}

/**
 * The planner ruled out the findings it was asked about: those returns stand as ok reviews with its reason and the
 * questions close. A return of a reviewer that asked nothing stays a return and goes to implement; with none left the
 * round goes on as an ok round.
 */
async function closeRuledOut(
  ctx: StepContext,
  documents: DocumentRepository,
  planner: SubtaskPlanner,
  answer: PlanChatEntry,
  asked: ReadonlySet<string | null>,
): Promise<PipelineResult> {
  const { key } = ctx.opened.run;
  const opinions: Opinion[] = [];
  for (const reviewer of REVIEWERS) {
    const review = await latestReview(documents, key, reviewer.name);
    if (!review) continue;
    opinions.push(
      review.decision === 'return' && asked.has(reviewer.name)
        ? ruledOutOpinion(reviewer.kind, review, answer.text)
        : opinionOf(reviewer.kind, review),
    );
  }
  const closed = await routeReview(
    planner.events,
    ctx,
    opinions,
    [textDocument(ARTIFACTS.reviewQuestions.kind, ''), ...opinions.flatMap(reviewDocuments)],
    null,
    false,
    { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] },
  );
  await planner.chat.markTaken(key, [answer.key]);
  return closed;
}

/**
 * Settles the questions of the review. With one still open it waits. When the person answered all of them, each
 * decision goes into the requirements as an instruction a person added, the questions are closed, and the run goes
 * back to implement with the finding and the decision.
 */
async function settleAnswers(
  ctx: StepContext,
  asked: { body: string; id: number },
  answersBody: string,
  documents: DocumentRepository,
  planner?: SubtaskPlanner,
  carried?: AskCarried,
): Promise<PipelineResult> {
  const questionsBody = asked.body;
  const stored = answered(answersBody);
  const questions = openQuestions(questionsBody, []);
  if (questions.some((question) => !(stored.get(question) ?? '').trim())) {
    return closeReview(
      ctx,
      { to: 'wait', reason: 'questions are open' },
      `${ctx.opened.startedAt} code-review waiting\n${questionsBody}`,
      [],
      null,
    );
  }
  const typed = await typedAnswer(ctx.opened.run.key, asked.id, planner?.chat);
  if (typed?.finding === 'ruled-out' && planner) {
    return closeRuledOut(ctx, documents, planner, typed, new Set(questions.map((question) => askedReviewer(question))));
  }
  let requirements = (await ctx.reread(ARTIFACTS.requirements)) ?? '';
  const issues = questions.map((question) => {
    const decision = (stored.get(question) ?? '').trim();
    requirements = withInstructions(
      requirements,
      `A person decided on the code review: ${question} - ${decision}`,
      false,
    );
    const reviewer = askedReviewer(question) ?? 'code-review';
    return issueOf(reviewer, `${reviewer} returned the change`, `${question}\nThe person decided: ${decision}`);
  });
  const closed = await closeReview(
    ctx,
    { to: 'return', step: 'implement', issues },
    `${ctx.opened.startedAt} code-review waiting\n${questions.length} questions answered`,
    [
      ...(carried?.documents ?? []),
      textDocument(ARTIFACTS.requirements.kind, requirements),
      textDocument(ARTIFACTS.reviewQuestions.kind, ''),
      returnNotes(issues),
      textDocument(ARTIFACTS.issues.kind, ARTIFACTS.issues.format(issues)),
    ],
    carried?.call ?? null,
    carried?.usage,
  );
  if (typed && planner) await planner.chat.markTaken(ctx.opened.run.key, [typed.key]);
  return closed;
}

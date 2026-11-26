import type { ReviewResult } from '../../agent-result/definitions/review';
import { latestReview } from '../../agent-result/stored-review';
import type { PlanChatEntry } from '../../contract/plan-chat';
import type { PipelineResult } from '../../core/pipeline-result';
import type { DocumentRepository } from '../../history/document.repository';
import type { EventRepository } from '../../history/event.repository';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { DocumentDraft } from '../../history/visit';
import type { StepContext } from '../base-step';
import type { Issue } from '../contract/step-contract';
import { REVIEWS } from '../contract/artifacts';
import { plannerWait } from '../implement/implement-question';
import { gateCounts } from '../shared/gate';
import { issueOf } from '../shared/handoff';
import { opinionOf, reviewDocuments, ruledOutOpinion, type Opinion } from './code-review-record';
import { opinionSummary } from './code-review-round-result';
import { closeReview } from './review-report';
import { returnToImplement } from './review-round';
import { REVIEWERS, type Reviewer } from './reviewer';

/** The step name a reviewer's question is asked under: `code-review-<name>`. */
const STEP_PREFIX = 'code-review-';

/** What the round holds after the preparation and before any reviewer starts. */
interface RoundState {
  fingerprint: string;
  kept: Opinion[];
  recovered: DocumentDraft[];
  pending: Reviewer[];
}

/** One finding question of the last round, with the review it is about and the planner's answer. */
interface FindingQuestion {
  reviewer: Reviewer;
  question: PlanChatEntry;
  review: ReviewResult;
  answer: PlanChatEntry | null;
  /** The planner escalated the question: the person who started the run holds it. */
  escalated: boolean;
}

/** What settling a round by its answers leaves: the visit is closed, or the round goes on without these reviewers. */
type AnswersOutcome = { closed: PipelineResult } | (RoundState & { taken: string[] });

/** The issue a reviewer's return and the planner's answer make for implement, or null when nothing goes back for it. */
function issueFor(reviewer: Reviewer, review: ReviewResult, answer: PlanChatEntry | null): Issue | null {
  const holds = review.decision === 'return' && answer?.finding !== 'ruled-out';
  const instruction = answer?.instruction?.trim();
  if (!holds && !instruction) return null;
  const parts = [
    ...(holds ? [review.review.trim()] : []),
    ...(answer ? [`The planner answered: ${answer.text.trim()}`] : []),
    ...(instruction ? [`The planner's instruction for implement: ${instruction}`] : []),
  ];
  const title = holds ? `${reviewer.name} returned the change` : `${reviewer.name}: the planner gave an instruction`;
  return issueOf(reviewer.name, title, parts.join('\n\n'));
}

/** Settles a code-review round by the planner's answers to the questions it asked, so no reviewer runs again for them. */
export class ReviewPlannerAnswers {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: EventRepository,
    private readonly chat?: PlanChatStore,
  ) {}

  /**
   * The round as it is when the last round asked no question about a finding, or its answers are taken. With a question not yet
   * answered the visit closes waiting. With all answered, a return that stands, or an instruction, closes the visit as a
   * return to implement; otherwise the reviewers whose finding was ruled out go on as ok reviews.
   */
  async settle(ctx: StepContext, round: RoundState): Promise<AnswersOutcome> {
    if (!this.chat) return { ...round, taken: [] };
    const { opened } = ctx;
    const stored = await this.counted(ctx, round.fingerprint);
    const asked = await this.lastQuestions(opened.run.key, stored);
    if (asked.length === 0) return { ...round, taken: [] };
    const open = asked.find((item) => !item.answer);
    if (open) {
      // A question the planner escalated waits for the person, as it did: only the others wait for the planner.
      const wait = open.escalated
        ? {
            route: { to: 'wait' as const, reason: 'questions are open' },
            summary: `${opened.startedAt} code-review waiting\n${open.question.text}`,
          }
        : plannerWait(opened.run, {
            step: `${STEP_PREFIX}${open.reviewer.name}`,
            startedAt: opened.startedAt,
            question: open.question.text,
          });
      return { closed: await closeReview(ctx, wait.route, wait.summary, [], null) };
    }
    const taken = asked.flatMap((item) => (item.answer ? [item.answer.key] : []));
    const issues = REVIEWERS.flatMap((reviewer) => {
      const review = stored.get(reviewer.name);
      const answer = asked.find((item) => item.reviewer === reviewer)?.answer ?? null;
      const issue = review ? issueFor(reviewer, review, answer) : null;
      return issue ? [issue] : [];
    });
    if (issues.length > 0) {
      const opinions = [...stored].map(([name, review]) => opinionOf(REVIEWS.of(name), review));
      const closed = await returnToImplement(this.events, ctx, {
        issues,
        kinds: issues.map((issue) => REVIEWS.of(issue.source)),
        line: `${opened.startedAt} code-review waiting\n${opinionSummary(opinions)}`,
        documents: [],
        call: null,
      });
      await this.take(opened.run.key, taken);
      return { closed };
    }
    const ruledOut = asked.filter((item) => item.review.decision === 'return');
    const opinions = ruledOut.map((item) => ruledOutOpinion(item.reviewer.kind, item.review, item.answer?.text ?? ''));
    const settled = new Set(ruledOut.map((item) => item.reviewer.kind));
    return {
      fingerprint: round.fingerprint,
      // A retried visit keeps the stored return of a reviewer: the ok opinion replaces it.
      kept: [...round.kept.filter((item) => !settled.has(item.kind)), ...opinions],
      recovered: [...round.recovered, ...opinions.flatMap(reviewDocuments)],
      pending: round.pending.filter((reviewer) => !settled.has(reviewer.kind)),
      taken,
    };
  }

  /** Marks the answers as taken: the visit that used them is closed, so a visit that died reads them again. */
  async take(key: string, answers: string[]): Promise<void> {
    if (answers.length > 0) await this.chat?.markTaken(key, answers);
  }

  /** The reviews of the run that count for this head, by reviewer. */
  private async counted(ctx: StepContext, fingerprint: string): Promise<Map<string, ReviewResult>> {
    const { run } = ctx.opened;
    const reviews = new Map<string, ReviewResult>();
    for (const reviewer of REVIEWERS) {
      const review = (await gateCounts(this.documents, run, reviewer.kind, fingerprint))
        ? await latestReview(this.documents, run.key, reviewer.name)
        : null;
      if (review) reviews.set(reviewer.name, review);
    }
    return reviews;
  }

  /**
   * The finding questions of the last round that asked any, for reviews that still count, with their answers. Empty
   * when every answer was taken already.
   */
  private async lastQuestions(key: string, stored: Map<string, ReviewResult>): Promise<FindingQuestion[]> {
    if (!this.chat) return [];
    const { entries } = await this.chat.read(key);
    const findings = entries.filter((entry) => entry.kind === 'question' && entry.about === 'finding');
    const last = findings.at(-1);
    if (!last) return [];
    // A question is named `ask-<step>-<attempt>`: the questions of one round end in the same attempt.
    const attempt = last.key.slice(`ask-${last.from}-`.length);
    const asked = findings.flatMap((question): FindingQuestion[] => {
      const reviewer = REVIEWERS.find((item) => `ask-${STEP_PREFIX}${item.name}-${attempt}` === question.key);
      const review = reviewer ? stored.get(reviewer.name) : undefined;
      const answer = entries.find((entry) => entry.kind === 'answer' && entry.key === `answer-${question.key}`);
      const escalated = entries.some(
        (entry) => entry.kind === 'escalation' && entry.key === `escalate-${question.key}`,
      );
      return reviewer && review ? [{ reviewer, question, review, answer: answer ?? null, escalated }] : [];
    });
    return asked.every((item) => item.answer?.state === 'taken') ? [] : asked;
  }
}

import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { EventRepository } from '../../history/event.repository';
import type { RunEntity } from '../../history/entities';
import type { DocumentDraft } from '../../history/visit';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { PipelineResult } from '../../core/pipeline-result';
import type { OpenedStep } from '../step-run';
import { RuntimeLimit } from '../../core/swarmloop-error';
import { StartRefused, refusedRoute } from '../shared/start-refused';
import type { Requirement } from '../../contract/requirement-list';
import { isResultKind } from '../../agent-result/result-definition';
import type { StepContext } from '../base-step';
import type { Route } from '../contract/step-contract';
import { limitRoute } from '../shared/limit-failover';
import { stampGate } from '../shared/gate';
import { textDocument } from '../shared/handoff';
import { ARTIFACTS } from '../contract/artifacts';
import { opinionSummary, othersOpenLine } from './code-review-round-result';
import { askPerson, reviewAsks } from './review-ask';
import type { PlanChatStore } from '../../history/plan-chat.store';
import { waitForPlanner } from '../implement/implement-question';
import { isSubtask } from '../../contract/subtask';
import { askedReviewer } from '../shared/reviewer-labels';
import type { Exchange } from './review-exchange';
import { closeReview, failed, noteHandoff, writeReport } from './review-report';
import { openOthers, othersOpen, routeReview, tallyRound } from './review-round';
import type { Finished, ReviewDeps } from './reviewer';
import type { Opinion } from './code-review-record';

/** What the round left and what the report needs, once the reviewers have answered. */
interface SettleInput {
  ctx: StepContext;
  deps: ReviewDeps;
  env: SwarmloopEnv;
  finished: Finished[];
  kept: Opinion[];
  recovered: DocumentDraft[];
  fingerprint: string;
  only: string | undefined;
  mounts: SandboxMount[];
  requirements: string;
  notes: string | null;
  impact: string | null;
  list: Requirement[] | null;
  exchanges: Map<string, Exchange>;
  fresh: boolean;
  thirdParty: boolean;
}

/** What the planner is asked: the reviewers' own questions, then the disagreements that implement and a reviewer did not settle. */
function plannerQuestions(
  finished: Finished[],
  disagreed: { question: string }[],
): { reviewer: string; question: string }[] {
  return [
    ...finished.flatMap((item) => (item.asked ? [{ reviewer: item.reviewer.name, question: item.asked }] : [])),
    ...disagreed.map((item) => ({ reviewer: askedReviewer(item.question) ?? 'code-review', question: item.question })),
  ];
}

/** The route a report launch ends the visit on when a provider limit or the door stopped it; null for any other error, and a Stop. */
function stoppedRoute(error: unknown): Route | null {
  if (error instanceof RuntimeLimit) return limitRoute(error);
  return error instanceof StartRefused ? refusedRoute(error) : null;
}

/** Ends the code-review visit after the reviewers: a limit, an error, a wait, an ask, or the routed report. */
export class ReviewSettle {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: EventRepository,
    private readonly chat?: PlanChatStore,
  ) {}

  async settle(input: SettleInput): Promise<PipelineResult> {
    const { ctx, deps, env, finished, kept, recovered, fingerprint, only } = input;
    const { mounts, requirements, notes, impact, list, exchanges, fresh, thirdParty } = input;
    const { opened, options } = ctx;
    const { key } = opened.run;
    const tally = tallyRound(kept, recovered, finished);
    const { reportContinued, opinions, stored, errors } = tally;
    const stopped = await this.refusedOrLimited(input, stored);
    if (stopped) return stopped;
    if (errors.length > 0) {
      const closed = await closeReview(ctx, failed(errors[0]), `${opened.startedAt} ${errors[0]}`, stored, []);
      await this.stamp(opened.run, stored, fingerprint);
      return closed;
    }
    const disagreed = thirdParty ? [] : reviewAsks(exchanges, finished, opened.startedAt);
    // The run's planner is asked first: a subtask has none, its disagreement goes to the person who started the run.
    const toPlanner = this.chat !== undefined && !isSubtask(opened.run);
    const questions = plannerQuestions(finished, toPlanner ? disagreed : []);
    if (this.chat && questions.length > 0) return this.waitForPlanner(this.chat, input, tally.stored, questions);
    const noted = await noteHandoff(this.documents, key, opinions, stored);
    if (only && othersOpen(only, opinions)) {
      const summary = opinionSummary(opinions);
      const waiting = await closeReview(
        ctx,
        { to: 'wait', reason: 'other reviewers are open' },
        `${opened.startedAt} ${othersOpenLine(openOthers(only, opinions))}\n${summary}`,
        noted,
        [],
      );
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    let written: Awaited<ReturnType<typeof writeReport>>;
    try {
      written = await writeReport(
        deps,
        opened,
        key,
        env,
        opinions,
        mounts,
        requirements,
        notes,
        impact,
        list,
        reportContinued,
        options.auto,
        options.answerErrors,
        exchanges,
      );
    } catch (error) {
      const route = stoppedRoute(error);
      if (!route) throw error;
      const waiting = await closeReview(ctx, route, `${opened.startedAt} ${(error as Error).message}`, noted, []);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const reportExchanges = written.exchange ? [written.exchange] : [];
    if ('error' in written) {
      const closed = await closeReview(
        ctx,
        failed(written.error),
        `${opened.startedAt} ${written.error}`,
        [...noted, ...written.documents],
        reportExchanges,
        written.usage,
      );
      await this.linkReport(deps, opened, written.startId);
      return closed;
    }
    const recorded = [...noted, ...written.documents];
    if (fresh) {
      recorded.push(textDocument(ARTIFACTS.rebaseConflict.kind, 'clear\n'));
    }
    const asks = toPlanner ? [] : disagreed;
    if (asks.length > 0) {
      const asked = await askPerson(ctx, asks, recorded, reportExchanges, written.usage);
      await this.linkReport(deps, opened, written.startId);
      await this.stamp(opened.run, [...stored, ...written.documents], fingerprint);
      return asked;
    }
    const routed = await routeReview(
      this.events,
      ctx,
      opinions,
      recorded,
      written.exchange ? [written.exchange] : [],
      thirdParty,
      written.usage,
    );
    await this.linkReport(deps, opened, written.startId);
    await this.stamp(opened.run, [...stored, ...written.documents], fingerprint);
    return routed;
  }

  /** Ends the visit on a start the door refused or a provider limit, once the reviewers that ran are recorded. */
  private async refusedOrLimited(input: SettleInput, stored: DocumentDraft[]): Promise<PipelineResult | null> {
    const { ctx, finished, fingerprint } = input;
    const { opened } = ctx;
    const refused = finished.find((item) => item.refused)?.refused;
    if (refused) {
      // The reviewers that started have answered and are recorded; none is cut short by the refusal of a later one.
      if (!(refused instanceof StartRefused)) throw refused;
      const waiting = await closeReview(
        ctx,
        refusedRoute(refused),
        `${opened.startedAt} ${refused.message}`,
        stored,
        [],
      );
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const limited = finished.find((item) => item.limit)?.limit;
    if (limited) {
      // The reviewers that answered keep their answers; the ones the limit stopped run again when the run goes on.
      const waiting = await closeReview(ctx, limitRoute(limited), `${opened.startedAt} ${limited.message}`, stored, []);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    return null;
  }

  /**
   * Closes the review as waiting for the planner. The reviewers that answered keep their answers; the ones that
   * asked, or whose disagreement is asked, run again with the planner's answer.
   */
  private async waitForPlanner(
    chat: PlanChatStore,
    input: SettleInput,
    stored: DocumentDraft[],
    questions: { reviewer: string; question: string }[],
  ): Promise<PipelineResult> {
    const { ctx, finished, fingerprint } = input;
    const { opened } = ctx;
    const ask = { chat, clock: ctx.clock, attemptId: opened.attemptId, startedAt: opened.startedAt };
    const waits = [];
    for (const { reviewer, question } of questions) {
      waits.push(await waitForPlanner(opened.run, { ...ask, step: `code-review-${reviewer}`, question }));
    }
    const waiting = new Set(questions.map((item) => item.reviewer));
    const reviewing = new Set(
      finished.filter((item) => waiting.has(item.reviewer.name)).map((item) => item.reviewer.kind),
    );
    const kept = stored.filter((document) => !reviewing.has(document.kind));
    const closed = await closeReview(ctx, waits[0].route, waits[0].summary, kept, []);
    await this.stamp(opened.run, kept, fingerprint);
    return closed;
  }

  /** The report is an exchange of the code-review visit, so its start is linked to that visit once it is closed. */
  private async linkReport(deps: ReviewDeps, opened: OpenedStep, startId: string | undefined): Promise<void> {
    if (!startId) return;
    const stat = (await deps.visits.listStats(opened.run.id)).find((item) => item.attemptId === opened.attemptId);
    if (stat) await deps.door.linkVisit(startId, stat.id);
  }

  /** The reviews this round stored count for the generation and the files they judged, once their visit is closed. */
  private async stamp(run: RunEntity, stored: DocumentDraft[], fingerprint: string): Promise<void> {
    for (const document of stored.filter((item) => !isResultKind(item.kind))) {
      await stampGate(this.documents, run, document.kind, fingerprint);
    }
  }
}

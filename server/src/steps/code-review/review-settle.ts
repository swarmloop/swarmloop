import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { EventRepository } from '../../history/event.repository';
import type { RunEntity } from '../../history/entities';
import type { DocumentDraft } from '../../history/visit';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { PipelineResult } from '../../core/pipeline-result';
import type { OpenedStep } from '../step-run';
import { isHostOutage, isUsageLimit } from '../../core/swarmloop-error';
import { isModelOutage, hostRoute } from '../shared/model-host-unavailable';
import { StartRefused, refusedRoute } from '../shared/start-refused';
import type { Requirement } from '../../contract/requirement-list';
import { isResultKind } from '../../agent-result/result-definition';
import type { StepContext } from '../base-step';
import type { Route } from '../contract/step-contract';
import { limitRoute } from '../shared/limit-failover';
import { stampGate } from '../shared/gate';
import { textDocument } from '../shared/handoff';
import { ARTIFACTS } from '../contract/artifacts';
import { askPerson, reviewAsks } from './review-ask';
import type { PlanChatStore } from '../../history/plan-chat.store';
import { waitForPlanner } from '../implement/implement-question';
import { isSubtask } from '../../contract/subtask';
import { askedReviewer } from '../shared/reviewer-labels';
import type { Exchange } from './review-exchange';
import { closeReview, failed, noteHandoff, usageOf, writeReport } from './review-report';
import { routeReview, tallyRound } from './review-round';
import type { Finished, ReviewDeps } from './reviewer';
import type { Opinion } from './code-review-record';
import type { FlowRepository } from '../../history/flow.repository';
import type { EpicRound } from '../shared/epic-round';
import { ownConflictMarker } from '../implement/own-conflict-marker';

/** What the round left and what the report needs, once the reviewers have answered. */
interface SettleInput {
  ctx: StepContext;
  deps: ReviewDeps;
  env: SwarmloopEnv;
  finished: Finished[];
  kept: Opinion[];
  recovered: DocumentDraft[];
  fingerprint: string;
  mounts: SandboxMount[];
  requirements: string;
  notes: string | null;
  impact: string | null;
  list: Requirement[] | null;
  exchanges: Map<string, Exchange>;
  fresh: boolean;
  thirdParty: boolean;
}

/**
 * What the planner is asked, one question for each reviewer: its own question followed by its finding, and the
 * disagreement that implement and the reviewer did not settle. A reviewer with both sends both texts.
 */
function plannerQuestions(
  finished: Finished[],
  disagreed: { question: string }[],
): { reviewer: string; question: string }[] {
  const texts = new Map<string, string[]>();
  const add = (reviewer: string, ...parts: string[]): void => {
    texts.set(reviewer, [...(texts.get(reviewer) ?? []), ...parts]);
  };
  for (const item of finished) {
    if (!item.asked) continue;
    const finding = item.parsed?.decision === 'return' ? `Its finding: ${item.parsed.result.review.trim()}` : null;
    add(item.reviewer.name, item.asked.trim(), ...(finding ? [finding] : []));
  }
  for (const item of disagreed) add(askedReviewer(item.question) ?? 'code-review', item.question);
  return [...texts].map(([reviewer, parts]) => ({ reviewer, question: parts.join('\n\n') }));
}

/** The route a report launch ends the visit on when a provider limit or the door stopped it; null for any other error, and a Stop. */
function stoppedRoute(error: unknown): Route | null {
  if (isUsageLimit(error)) return limitRoute(error);
  if (isHostOutage(error)) return hostRoute(error);
  return error instanceof StartRefused ? refusedRoute(error) : null;
}

/** Ends the code-review visit after the reviewers: a limit, an error, a wait, an ask, or the routed report. */
export class ReviewSettle {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: EventRepository,
    private readonly chat?: PlanChatStore,
    private readonly flows?: FlowRepository,
    private readonly epicRound?: EpicRound,
  ) {}

  async settle(input: SettleInput): Promise<PipelineResult> {
    const { ctx, deps, env, finished, kept, recovered, fingerprint } = input;
    const { mounts, requirements, notes, impact, list, exchanges, fresh, thirdParty } = input;
    const { opened, options } = ctx;
    const { key } = opened.run;
    const tally = tallyRound(kept, recovered, finished);
    const { reportContinued, opinions, stored, errors } = tally;
    const stopped = await this.refusedOrLimited(input, stored);
    if (stopped) return stopped;
    if (errors.length > 0) {
      const closed = await closeReview(ctx, failed(errors[0]), `${opened.startedAt} ${errors[0]}`, stored, null);
      await this.stamp(opened.run, stored, fingerprint);
      return closed;
    }
    const disagreed = thirdParty ? [] : reviewAsks(exchanges, finished, opened.startedAt);
    // The run's planner is asked first: a subtask has none, its disagreement goes to the person who started the run.
    const toPlanner = this.chat !== undefined && !isSubtask(opened.run);
    const questions = plannerQuestions(finished, toPlanner ? disagreed : []);
    if (this.chat && questions.length > 0) return this.waitForPlanner(this.chat, input, tally.stored, questions);
    const noted = await noteHandoff(this.documents, key, opinions, stored);
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
      const usage = isModelOutage(error) ? usageOf(error.result) : undefined;
      const waiting = await closeReview(
        ctx,
        route,
        `${opened.startedAt} ${(error as Error).message}`,
        noted,
        null,
        usage,
      );
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const reportCall = written.call;
    if ('error' in written) {
      const closed = await closeReview(
        ctx,
        failed(written.error),
        `${opened.startedAt} ${written.error}`,
        [...noted, ...written.documents],
        reportCall,
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
      const asked = await askPerson(ctx, asks, recorded, reportCall, written.usage);
      await this.linkReport(deps, opened, written.startId);
      await this.stamp(opened.run, [...stored, ...written.documents], fingerprint);
      return asked;
    }
    const ended = await this.endRound(ctx, opinions, recorded);
    const routed = await routeReview(
      this.events,
      ctx,
      opinions,
      ended.documents,
      reportCall,
      thirdParty,
      written.usage,
      ended.pass,
    );
    await this.linkReport(deps, opened, written.startId);
    await this.stamp(opened.run, [...stored, ...written.documents], fingerprint);
    return routed;
  }

  /**
   * Ends an open resolution round of a split run that no reviewer returned: its open tasks move, and the pass goes
   * back to implement, where the split pass leaves the epic waiting. A conflict of the round's own edits goes to
   * implement as a marker, the round staying open. With no round to end the documents stay and the pass is `next`.
   */
  private async endRound(
    ctx: StepContext,
    opinions: Opinion[],
    recorded: DocumentDraft[],
  ): Promise<{ documents: DocumentDraft[]; pass: Route }> {
    const { opened } = ctx;
    const none: { documents: DocumentDraft[]; pass: Route } = { documents: recorded, pass: { to: 'next' } };
    const pass: Route = { to: 'jump', step: 'implement' };
    if (!this.epicRound || !opened.run.split || opinions.some((item) => item.decision === 'return')) return none;
    if ((await ctx.reread(ARTIFACTS.epicRound))?.trim() !== 'open') return none;
    const { conflict } = await this.epicRound.finish(opened.run, (await ctx.reread(ARTIFACTS.subtasks)) ?? []);
    if (conflict) {
      return {
        documents: [...recorded, textDocument(ARTIFACTS.rebaseConflict.kind, ownConflictMarker(conflict))],
        pass,
      };
    }
    await this.flows?.noteFlow(opened.run.key, ['implementation', 'checks', 'code-review', 'ci'], 'implement');
    return {
      documents: [
        ...recorded,
        textDocument(ARTIFACTS.epicRound.kind, ''),
        textDocument(ARTIFACTS.return.kind, ''),
        textDocument(ARTIFACTS.issues.kind, ARTIFACTS.issues.format([])),
      ],
      pass,
    };
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
        null,
      );
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const limited = finished.find((item) => item.limit)?.limit;
    if (limited) {
      // The reviewers that answered keep their answers; the ones the limit stopped run again when the run goes on.
      const waiting = await closeReview(
        ctx,
        limitRoute(limited),
        `${opened.startedAt} ${limited.message}`,
        stored,
        null,
      );
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const outage = finished.find((item) => item.outage)?.outage;
    if (outage) {
      // The reviewers that answered keep their answers; the ones whose model host did not answer run again at the next try.
      const waiting = await closeReview(ctx, hostRoute(outage), `${opened.startedAt} ${outage.message}`, stored, null);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    return null;
  }

  /**
   * Closes the review as waiting for the planner, with one question about the finding of each reviewer that asked.
   * Every reviewer's decision is kept and stamped: the next visit settles by them and the planner's answers.
   */
  private async waitForPlanner(
    chat: PlanChatStore,
    input: SettleInput,
    stored: DocumentDraft[],
    questions: { reviewer: string; question: string }[],
  ): Promise<PipelineResult> {
    const { ctx, fingerprint } = input;
    const { opened } = ctx;
    const ask = {
      chat,
      clock: ctx.clock,
      attemptId: opened.attemptId,
      startedAt: opened.startedAt,
      about: 'finding' as const,
    };
    const waits = [];
    for (const { reviewer, question } of questions) {
      waits.push(await waitForPlanner(opened.run, { ...ask, step: `code-review-${reviewer}`, question }));
    }
    const closed = await closeReview(ctx, waits[0].route, waits[0].summary, stored, null);
    await this.stamp(opened.run, stored, fingerprint);
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

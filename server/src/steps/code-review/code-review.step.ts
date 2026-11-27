import { agentFor } from '../../config/agents';
import { Injectable, Optional } from '@nestjs/common';
import type {
  AgentProfile,
  InputSpec,
  StepCapabilities,
  StepDescriptor,
  StepInput,
  StepResult,
} from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { realpathSync } from 'fs';
import { SwarmloopEnv } from '../../config/env';
import { EventRepository } from '../../history/event.repository';
import { assertInsideWork, workRoots } from '../../sandbox/allowed-path';
import { root } from '../../history/run-paths';
import { VisitDraft } from '../../history/visit';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { BaseStep, StepContext, VisitLeftOpen } from '../base-step';
import { lateInput } from '../agent-step';
import { AgentDoor } from '../shared/agent-door';
import { StarterBriefing } from '../shared/starter-briefing';
import { RunReport } from '../shared/run-report';
import { OpenReviewRounds } from '../shared/open-review-rounds';
import { CheckoutService } from '../shared/checkout.service';
import { requiredDocument } from '../step';
import { MergeMarks } from '../shared/merge-marks';
import { writeReviewDiff } from './review-diff';
import { approvedPlan, foreignReviewOf, storedCheckout } from './review-input';
import { closeReview } from './review-report';
import { reportDue, runRound } from './review-round';
import type { ReviewDeps } from './reviewer';
import { settleAsked } from './review-ask';
import { ReviewPlannerAnswers } from './review-planner-answers';
import { ReviewSettle } from './review-settle';
import { prepareReview, type PrepareDeps } from './review-prepare';
import { renderImplementation } from '../implement/implement-record';
import { storedImpact } from '../shared/research-reads';
import { ARTIFACTS, REVIEW_RESULTS } from '../contract/artifacts';
import { CODE_REVIEWERS } from '../../contract/steps';
import { PlanChatStore } from '../../history/plan-chat.store';
import { EpicRound } from '../shared/epic-round';
import { refusedRoute, StartRefused } from '../shared/start-refused';

const INPUTS = {
  implementationResult: { artifact: ARTIFACTS.implementationResult, need: 'optional' },
  implementation: lateInput(ARTIFACTS.implementation),
  planResult: lateInput(ARTIFACTS.planResult),
  planImproveResult: lateInput(ARTIFACTS.planImproveResult),
  implementationImproveResult: lateInput(ARTIFACTS.implementationImproveResult),
  // Without requirements the review falls back to the run prompt, and a third-party review has none.
  requirements: lateInput(ARTIFACTS.requirements),
  requirementList: lateInput(ARTIFACTS.requirementList),
  requirementCoverage: lateInput(ARTIFACTS.requirementCoverage),
  repos: lateInput(ARTIFACTS.repos),
  impact: lateInput(ARTIFACTS.impact),
  researchResult: lateInput(ARTIFACTS.researchResult),
  rebaseConflict: lateInput(ARTIFACTS.rebaseConflict),
} as const satisfies InputSpec;

@Injectable()
export class CodeReviewStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'code-review';
  readonly inputs = INPUTS;
  readonly outputs = [
    ARTIFACTS.reviewReport,
    ARTIFACTS.reviewReportResult,
    ...Object.values(REVIEW_RESULTS),
    ARTIFACTS.return,
    ARTIFACTS.issues,
    ARTIFACTS.repos,
    ARTIFACTS.rebaseConflict,
    ARTIFACTS.reviewQuestions,
    ARTIFACTS.questionParts,
    ARTIFACTS.requirements,
    ARTIFACTS.epicRound,
  ];
  override readonly usesModel = true;
  override readonly capabilities: StepCapabilities = { path: true };

  private readonly settling: ReviewSettle;
  private readonly answers: ReviewPlannerAnswers;
  private readonly briefing: StarterBriefing;

  constructor(
    kernel: StepKernel,
    private readonly events: EventRepository,
    private readonly worktrees: CheckoutService,
    private readonly sandbox: SandboxService,
    private readonly door: AgentDoor,
    private readonly runReport: RunReport,
    @Optional() private readonly planChat?: PlanChatStore,
    @Optional() private readonly openRounds?: OpenReviewRounds,
    @Optional() epicRound?: EpicRound,
  ) {
    super(kernel);
    this.settling = new ReviewSettle(this.documents, events, planChat, this.flows, epicRound);
    this.answers = new ReviewPlannerAnswers(this.documents, events, planChat);
    this.briefing = new StarterBriefing(this.runs, this.documents);
  }

  private prepareDeps(): PrepareDeps {
    return {
      runs: this.runs,
      flows: this.flows,
      documents: this.documents,
      visits: this.visits,
      worktrees: this.worktrees,
      config: this.config,
    };
  }

  override describe(env: SwarmloopEnv): StepDescriptor {
    return { ...super.describe(env), reviewers: this.reviewers(env), agent: this.profile(env) };
  }

  /** The angles one round runs, each with the model and mode of its launch. */
  reviewers(env: SwarmloopEnv): { name: string; model: string; mode: string }[] {
    return CODE_REVIEWERS.map((name) => ({
      name,
      model: agentFor(env, null, `code-review-${name}`).model,
      mode: 'ask',
    }));
  }

  /** The launch that writes the report. The reviewers have their own, listed by `reviewers`. */
  private profile(env: SwarmloopEnv): AgentProfile {
    return {
      ...agentFor(env, null, 'code-review'),
      mode: 'ask',
      tools: 'read',
      timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
      session: 'resume',
    };
  }

  override async missingInput(key: string, options: StepOptions): Promise<string | null> {
    if (
      options.path ||
      (await storedCheckout(this.runs, this.documents, key)) ||
      (await foreignReviewOf(this.runs, this.flows, key))
    ) {
      return null;
    }
    return requiredDocument(this.documents, key, ARTIFACTS.implementation.kind);
  }

  protected override failureVisit(): Partial<VisitDraft> {
    return { mode: 'ask', samples: [], httpCalls: [] };
  }

  /** The review ends its own visit, so `work` hands the closed result back through `VisitLeftOpen`. */
  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const env = this.config.env;
    const { key } = ctx.opened.run;
    try {
      if (ctx.options.path) {
        assertInsideWork(ctx.options.path, workRoots(this.config));
        ctx.opened.run.targetPath = realpathSync(ctx.options.path);
      }
      await this.sandbox.assertReady(agentFor(env, ctx.opened.run, 'code-review').runtime);
      const result = input.implementationResult;
      const notes = result ? renderImplementation(result.implementation) : await ctx.reread(ARTIFACTS.implementation);
      throw new VisitLeftOpen(await this.review(notes, ctx, env));
    } finally {
      this.openRounds?.close(key);
    }
  }

  /** What the reviewers of this round read besides the diff: the handoff, plan, impact and, for a split parent, its epic. */
  private async roundReads(ctx: StepContext) {
    const { run } = ctx.opened;
    const handoff = await ctx.reread(ARTIFACTS.handoff);
    const requirementList = await ctx.reread(ARTIFACTS.requirementList);
    const coverage = await ctx.reread(ARTIFACTS.requirementCoverage);
    const plan = await approvedPlan(this.documents, run.key);
    const split = run.split;
    return {
      handoff,
      list: requirementList?.length ? requirementList : null,
      plan,
      coveredPlan: coverage ? await approvedPlan(this.documents, run.key, coverage) : plan,
      impact: storedImpact(await ctx.reread(ARTIFACTS.researchResult), await ctx.reread(ARTIFACTS.impact)),
      contract: split ? await ctx.reread(ARTIFACTS.contract) : null,
      starter: await this.briefing.fullText(run),
      keep: split ? await ctx.reread(ARTIFACTS.keep) : null,
      subtasks: split ? await ctx.reread(ARTIFACTS.subtasks) : null,
      round: split ? (await ctx.reread(ARTIFACTS.epicRound))?.trim() === 'open' : false,
    };
  }

  private async review(notes: string | null, ctx: StepContext, env: SwarmloopEnv): Promise<PipelineResult> {
    const { opened, options } = ctx;
    const { key } = opened.run;
    const deps = {
      documents: this.documents,
      visits: this.visits,
      root: root(this.config),
      door: this.door,
      start: { by: options.startBy ?? 'person', level: options.level ?? null, prompt: options.prompt ?? '' },
      runReport: this.runReport,
      chat: this.planChat,
      briefing: this.briefing,
      onReportStart: () => this.openRounds?.reportStarted(key),
    };
    const prepared = await ctx.activity('Preparing', () => prepareReview(this.prepareDeps(), notes, ctx));
    const { requirements, thirdParty, mounts, fresh, retry, exchanges, returned, diff, fingerprint } = prepared;
    const answered = await this.answers.settle(ctx, prepared);
    if ('closed' in answered) {
      return answered.closed;
    }
    const { kept, pending, recovered } = answered;
    this.openRounds?.open(key, {
      reviewers: pending.map((item) => item.name),
      reportDue: reportDue(kept, pending),
      reportStarted: false,
    });
    const settled = await settleAsked(
      ctx,
      this.documents,
      this.planChat ? { chat: this.planChat, events: this.events } : undefined,
    );
    if (settled) {
      return settled;
    }
    const calls = pending.length + (reportDue(kept, pending) ? 1 : 0);
    if (calls > 0) {
      try {
        // One ask for the whole round, so the money never stops it between its reviewers and its report.
        await this.door.admitRound(opened.run, 'code-review', deps.start.by);
      } catch (error) {
        if (!(error instanceof StartRefused)) throw error;
        return closeReview(ctx, refusedRoute(error), `${opened.startedAt} ${error.message}`, [], null);
      }
    }
    const admitted: ReviewDeps = { ...deps, start: { ...deps.start, round: true } };
    writeReviewDiff(root(this.config), key, diff.patch);
    const { handoff, list, plan, coveredPlan, impact, contract, starter, keep, subtasks, round } =
      await this.roundReads(ctx);
    const finished = await runRound(admitted, {
      opened,
      key,
      env,
      pending,
      requirements,
      notes,
      mounts,
      handoff,
      returned,
      diff,
      plan,
      coveredPlan,
      list,
      impact,
      contract,
      starter,
      subtasks,
      keep,
      round,
      outside: await new MergeMarks(this.documents).outsideOwn(
        key,
        { files: await this.briefing.ownFiles(opened.run) },
        diff.files,
      ),
      auto: options.auto,
      fresh,
      retry,
      exchanges,
    });
    const closed = await this.settling.settle({
      ctx,
      deps: admitted,
      env,
      finished,
      kept,
      recovered,
      fingerprint,
      mounts,
      requirements,
      notes,
      impact,
      list,
      exchanges,
      fresh,
      thirdParty,
    });
    // The answers are taken once the visit that used them is closed, so a visit that dies settles again from them.
    await this.answers.take(key, answered.taken);
    return closed;
  }
}

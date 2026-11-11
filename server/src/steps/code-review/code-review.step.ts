import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import { limitRoute } from '../shared/limit-failover';
import { agentFor } from '../../config/agents';
import { Injectable } from '@nestjs/common';
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
import { CheckoutRepository } from '../../history/checkout.repository';
import { EventRepository } from '../../history/event.repository';
import { assertInsideWork, workRoots } from '../../sandbox/allowed-path';
import { root } from '../../history/run-paths';
import { DocumentDraft, VisitDraft } from '../../history/visit';
import { Charge, chargeReview } from '../../agent/spend';
import { ModelPrice } from '../../agent/limits';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { RuntimeLimit, SwarmloopError } from '../../core/swarmloop-error';
import { BaseStep, StepContext, VisitLeftOpen } from '../base-step';
import { lateInput } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { returnedNotes, textDocument } from '../shared/handoff';
import { gateCounts, stampGate, worktreesFingerprint } from '../shared/gate';
import type { RunEntity } from '../../history/entities';
import { CheckoutService } from '../shared/checkout.service';
import { requiredDocument } from '../step';
import { reviewDiffSection, writeReviewDiff } from './review-diff';
import { REVIEWERS } from './reviewer';
import {
  approvedPlan,
  detachForeign,
  foreignReview,
  foreignReviewOf,
  interruptedAttempt,
  pathMount,
  repoMounts,
  retrying,
  storedCheckout,
} from './review-input';
import { closeReview, failed, noteHandoff, writeReport } from './review-report';
import {
  othersOpen,
  reportDue,
  reviewReturn,
  routeReview,
  runRound,
  sameReviewedDiff,
  selectReviewers,
  tallyRound,
} from './review-round';
import { ARTIFACTS } from '../contract/artifacts';
import { CODE_REVIEWERS } from '../../contract/steps';

const INPUTS = {
  implementation: { artifact: ARTIFACTS.implementation, need: 'optional' },
  // Without requirements the review falls back to the run prompt, and a third-party review has none.
  requirements: lateInput(ARTIFACTS.requirements),
  repos: lateInput(ARTIFACTS.repos),
  impact: lateInput(ARTIFACTS.impact),
  rebaseConflict: lateInput(ARTIFACTS.rebaseConflict),
} as const satisfies InputSpec;

@Injectable()
export class CodeReviewStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'code-review';
  readonly inputs = INPUTS;
  readonly outputs = [
    ARTIFACTS.reviewReport,
    ARTIFACTS.return,
    ARTIFACTS.issues,
    ARTIFACTS.repos,
    ARTIFACTS.rebaseConflict,
  ];
  override readonly usesModel = true;
  override readonly capabilities: StepCapabilities = { path: true };

  constructor(
    kernel: StepKernel,
    private readonly checkouts: CheckoutRepository,
    private readonly events: EventRepository,
    private readonly worktrees: CheckoutService,
    private readonly sandbox: SandboxService,
    private readonly launcher: AgentLauncher,
  ) {
    super(kernel);
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

  async charge(
    key: string,
    env: SwarmloopEnv,
    prices: (runtime: RuntimeName) => Promise<Record<string, ModelPrice>>,
    attemptId: string | null,
  ): Promise<Charge | null> {
    const run = await this.runs.findRun(key);
    const visits = run ? await this.visits.listStats(run.id) : [];
    return chargeReview(
      root(this.config),
      key,
      visits,
      prices,
      attemptId,
      (step) => agentFor(env, run, step) ?? agentFor(env, run, 'code-review'),
    );
  }

  protected override failureVisit(): Partial<VisitDraft> {
    return { mode: 'ask', exchanges: [], samples: [], httpCalls: [] };
  }

  /** The review ends its own visit, so `work` hands the closed result back through `VisitLeftOpen`. */
  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const env = this.config.env;
    if (ctx.options.path) {
      assertInsideWork(ctx.options.path, workRoots(this.config));
      ctx.opened.run.targetPath = realpathSync(ctx.options.path);
    }
    await this.sandbox.assertReady(agentFor(env, ctx.opened.run, 'code-review').runtime);
    throw new VisitLeftOpen(await this.review(input.implementation, ctx, env));
  }

  /** Everything before the first reviewer or report launches: the worktrees, the diff, and which reviewers run. */
  private async prepare(notes: string | null, ctx: StepContext) {
    const { opened, options } = ctx;
    const { key } = opened.run;
    const checkout = options.path ?? (notes?.trim() ? null : opened.run.targetPath);
    let thirdParty = Boolean(checkout);
    if (!thirdParty && !notes?.trim()) {
      if (!(await foreignReview(this.flows, opened.run.id))) {
        throw new SwarmloopError('implementation is missing');
      }
      await detachForeign(this.documents, this.worktrees, opened);
      thirdParty = true;
    }
    if (checkout) {
      assertInsideWork(checkout, workRoots(this.config));
      opened.run.targetPath = realpathSync(checkout);
    }
    const requirements = ((await ctx.reread(ARTIFACTS.requirements)) ?? '').trim() || opened.run.prompt || '';
    if (!thirdParty && !requirements.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const mounts = checkout ? pathMount(checkout) : await repoMounts(this.runs, this.documents, root(this.config), key);
    const only = REVIEWERS.some((item) => item.name === options.reviewer) ? options.reviewer : undefined;
    const fresh = ((await ctx.reread(ARTIFACTS.rebaseConflict)) ?? '').trim() === 'review';
    const retry = fresh ? false : await retrying(this.visits, opened);
    const attemptId = retry ? await interruptedAttempt(this.visits, opened) : null;
    const returned = await returnedNotes(this.documents, opened.run.id);
    const diff = await reviewDiffSection(mounts, await this.checkouts.listDenyPaths(), opened.run.prompt);
    const same = sameReviewedDiff(root(this.config), key, diff.patch);
    const repeated = reviewReturn(returned) && same;
    const fingerprint = await worktreesFingerprint(mounts.map((mount) => mount.hostPath));
    const { kept, pending, recovered, stale } = await selectReviewers(this.documents, root(this.config), {
      key,
      only,
      fresh,
      retry,
      attemptId,
      same,
      repeated,
      counts: (kind) => gateCounts(this.documents, opened.run, kind, fingerprint),
    });
    return {
      requirements,
      thirdParty,
      mounts,
      only,
      fresh,
      retry,
      repeated,
      returned,
      diff,
      fingerprint,
      kept,
      pending,
      recovered,
      stale,
    };
  }

  private async review(notes: string | null, ctx: StepContext, env: SwarmloopEnv): Promise<PipelineResult> {
    const { opened, options } = ctx;
    const { key } = opened.run;
    const deps = {
      documents: this.documents,
      visits: this.visits,
      root: root(this.config),
      launcher: this.launcher,
    };
    const {
      requirements,
      thirdParty,
      mounts,
      only,
      fresh,
      retry,
      repeated,
      returned,
      diff,
      fingerprint,
      kept,
      pending,
      recovered,
      stale,
    } = await ctx.activity('Preparing', () => this.prepare(notes, ctx));
    const calls = pending.length + (reportDue(only, kept, pending) ? 1 : 0);
    if (options.auto && calls > 0 && opened.run.agentCalls + calls > env.MAX_AGENT_CALLS) {
      return closeReview(
        ctx,
        failed('code-review does not fit'),
        `${opened.startedAt} code-review does not fit`,
        [],
        [],
      );
    }
    writeReviewDiff(root(this.config), key, diff.patch);
    const handoff = await ctx.reread(ARTIFACTS.handoff);
    const plan = approvedPlan(requirements);
    const impact = await ctx.reread(ARTIFACTS.impact);
    const split = opened.run.split;
    const contract = split ? await ctx.reread(ARTIFACTS.contract) : null;
    const subtasks = split ? await ctx.reread(ARTIFACTS.subtasks) : null;
    const finished = await runRound(deps, {
      opened,
      key,
      env,
      pending,
      stale,
      requirements,
      notes,
      mounts,
      handoff,
      returned,
      diff,
      plan,
      impact,
      contract,
      subtasks,
      auto: options.auto,
      fresh,
      retry,
      repeated,
    });
    const { reportContinued, opinions, stored, errors } = tallyRound(kept, recovered, finished, repeated);
    const limited = finished.find((item) => item.limit)?.limit;
    if (limited) {
      // The reviewers that answered keep their answers; the ones the limit stopped run again when the run goes on.
      const waiting = await closeReview(ctx, limitRoute(limited), `${opened.startedAt} ${limited.message}`, stored, []);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    if (errors.length > 0) {
      const closed = await closeReview(ctx, failed(errors[0]), `${opened.startedAt} ${errors[0]}`, stored, []);
      await this.stamp(opened.run, stored, fingerprint);
      return closed;
    }
    const noted = await noteHandoff(this.documents, key, opinions, stored);
    if (only && othersOpen(only, opinions)) {
      const summary = opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
      const waiting = await closeReview(
        ctx,
        { to: 'wait', reason: 'other reviewers are open' },
        `${opened.startedAt} code-review waiting\n${summary}`,
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
        reportContinued,
        options.auto,
      );
    } catch (error) {
      if (!(error instanceof RuntimeLimit)) {
        throw error;
      }
      const waiting = await closeReview(ctx, limitRoute(error), `${opened.startedAt} ${error.message}`, noted, []);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const reportExchanges = written.exchange ? [written.exchange] : [];
    if ('error' in written) {
      return closeReview(
        ctx,
        failed(written.error),
        `${opened.startedAt} ${written.error}`,
        noted,
        reportExchanges,
        written.usage,
      );
    }
    const recorded = [...noted, written.document];
    if (fresh) {
      recorded.push(textDocument(ARTIFACTS.rebaseConflict.kind, 'clear\n'));
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
    await this.stamp(opened.run, [...stored, written.document], fingerprint);
    return routed;
  }

  /** The reviews this round stored count for the generation and the files they judged, once their visit is closed. */
  private async stamp(run: RunEntity, stored: DocumentDraft[], fingerprint: string): Promise<void> {
    for (const document of stored) {
      await stampGate(this.documents, run, document.kind, fingerprint);
    }
  }
}

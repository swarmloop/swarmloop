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
import { root } from '../../history/run-paths';
import { VisitDraft } from '../../history/visit';
import { Charge, chargeReview } from '../../agent/spend';
import { ModelPrice } from '../../agent/limits';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { BaseStep, StepContext, VisitLeftOpen } from '../base-step';
import { lateInput } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { returnedNotes, textDocument } from '../shared/handoff';
import { CheckoutService } from '../shared/checkout.service';
import { requiredDocument } from '../step';
import { reviewDiffSection, writeReviewDiff } from './review-diff';
import { REVIEWERS, reviewModel } from './reviewer';
import {
  approvedPlan,
  detachForeign,
  foreignReview,
  foreignReviewOf,
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
    return CODE_REVIEWERS.map((name) => ({ name, model: reviewModel(env), mode: 'ask' }));
  }

  /** The launch that writes the report. The reviewers have their own, listed by `reviewers`. */
  private profile(env: SwarmloopEnv): AgentProfile {
    return {
      runtime: env.RUNTIME,
      model: reviewModel(env),
      mode: 'ask',
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

  charge(key: string, env: SwarmloopEnv, prices: Record<string, ModelPrice>): Promise<Charge | null> {
    return chargeReview(root(this.config), key, env, prices);
  }

  protected override failureVisit(): Partial<VisitDraft> {
    return { mode: 'ask', exchanges: [], samples: [], httpCalls: [] };
  }

  /** The review ends its own visit, so `work` hands the closed result back through `VisitLeftOpen`. */
  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const env = this.config.env;
    if (ctx.options.path) {
      ctx.opened.run.targetPath = realpathSync(ctx.options.path);
    }
    await this.sandbox.assertReady(env.RUNTIME);
    throw new VisitLeftOpen(await this.review(input.implementation, ctx, env));
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
    const returned = await returnedNotes(this.documents, opened.run.id);
    const diff = await reviewDiffSection(mounts, await this.checkouts.listDenyPaths());
    const same = sameReviewedDiff(root(this.config), key, diff.patch);
    const repeated = reviewReturn(returned) && same;
    const { kept, pending, recovered, stale } = await selectReviewers(this.documents, root(this.config), {
      key,
      only,
      fresh,
      retry,
      same,
      repeated,
    });
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
      auto: options.auto,
      fresh,
      retry,
      repeated,
    });
    const { reportContinued, opinions, stored, errors } = tallyRound(kept, recovered, finished, repeated);
    if (errors.length > 0) {
      return closeReview(ctx, failed(errors[0]), `${opened.startedAt} ${errors[0]}`, stored, []);
    }
    const noted = await noteHandoff(this.documents, key, opinions, stored);
    if (only && othersOpen(only, opinions)) {
      const summary = opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
      return closeReview(
        ctx,
        { to: 'wait', reason: 'other reviewers are open' },
        `${opened.startedAt} code-review waiting\n${summary}`,
        noted,
        [],
      );
    }
    const written = await writeReport(
      deps,
      opened,
      key,
      env,
      opinions,
      mounts,
      requirements,
      notes,
      reportContinued,
      options.auto,
    );
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
    return routeReview(
      this.events,
      ctx,
      opinions,
      recorded,
      written.exchange ? [written.exchange] : [],
      thirdParty,
      written.usage,
    );
  }
}

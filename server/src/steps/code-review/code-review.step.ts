import { Inject, Injectable } from '@nestjs/common';
import { realpathSync } from 'fs';
import { AppConfig, SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { Clock } from '../../core/clock';
import { VisitDraft } from '../../history/visit';
import { AGENT_RUNNER, AgentProcessRunner } from '../../agent/agent-runner';
import { Charge, chargeReview } from '../../agent/spend';
import { ModelPrice } from '../../agent/limits';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { BaseStep, StepContext } from '../base-step';
import { composedReturn, textDocument } from '../shared/handoff';
import { PrepareStep } from '../prepare/prepare.step';
import { requiredDocument } from '../step';
import { REBASE_CONFLICT } from '../../git/rebase-worktree';
import { reviewDiffSection, writeReviewDiff } from './review-diff';
import { REVIEWERS } from './reviewer';
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
import { closeReview, noteHandoff, writeReport } from './review-report';
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

@Injectable()
export class CodeReviewStep extends BaseStep {
  readonly name: StepName = 'code-review';
  readonly requiredKind = 'implementation';
  override readonly usesModel = true;
  readonly acceptsPath = true;

  constructor(
    history: HistoryService,
    clock: Clock,
    private readonly config: AppConfig,
    private readonly prepare: PrepareStep,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {
    super(history, clock);
  }

  override async missingInput(key: string, options: StepOptions): Promise<string | null> {
    if (options.path || (await storedCheckout(this.history, key)) || (await foreignReviewOf(this.history, key))) {
      return null;
    }
    return requiredDocument(this.history, key, this.requiredKind);
  }

  charge(key: string, env: SwarmloopEnv, prices: Record<string, ModelPrice>): Promise<Charge | null> {
    return chargeReview(this.history.root(), key, env, prices);
  }

  protected override failureVisit(): Partial<VisitDraft> {
    return { mode: 'ask', exchanges: [], samples: [], httpCalls: [] };
  }

  protected async run(key: string, options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    const env = this.config.env;
    if (options.path) {
      ctx.opened.run.targetPath = realpathSync(options.path);
    }
    await this.sandbox.assertReady(env.RUNTIME);
    return this.review(key, ctx, options, env);
  }

  private async review(
    key: string,
    ctx: StepContext,
    options: StepOptions,
    env: SwarmloopEnv,
  ): Promise<PipelineResult> {
    const { opened } = ctx;
    const deps = { history: this.history, agent: this.agent };
    const notes = await this.history.latestBody(key, 'implementation');
    const checkout = options.path ?? (notes?.trim() ? null : opened.run.targetPath);
    let thirdParty = Boolean(checkout);
    if (!thirdParty && !notes?.trim()) {
      if (!(await foreignReview(this.history, opened.run.id))) {
        throw new SwarmloopError('implementation is missing');
      }
      await detachForeign(this.history, this.prepare, opened);
      thirdParty = true;
    }
    if (checkout) {
      opened.run.targetPath = realpathSync(checkout);
    }
    const requirements = ((await this.history.latestBody(key, 'requirements')) ?? '').trim() || opened.run.prompt || '';
    if (!thirdParty && !requirements.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const mounts = checkout ? pathMount(checkout) : await repoMounts(this.history, key);
    const only = REVIEWERS.some((item) => item.name === options.reviewer) ? options.reviewer : undefined;
    const fresh = ((await this.history.latestBody(key, REBASE_CONFLICT)) ?? '').trim() === 'review';
    const retry = fresh ? false : await retrying(this.history, opened);
    const returned = composedReturn(await this.history.listDocuments(opened.run.id));
    const diff = await reviewDiffSection(mounts, await this.history.listDenyPaths());
    const same = sameReviewedDiff(this.history.root(), key, diff.patch);
    const repeated = reviewReturn(returned) && same;
    const { kept, pending, recovered, stale } = await selectReviewers(this.history, {
      key,
      only,
      fresh,
      retry,
      same,
      repeated,
    });
    const calls = pending.length + (reportDue(only, kept, pending) ? 1 : 0);
    if (options.auto && calls > 0 && opened.run.agentCalls + calls > env.MAX_AGENT_CALLS) {
      return closeReview(ctx, 'failed', 1, `${opened.startedAt} code-review does not fit`, [], []);
    }
    writeReviewDiff(this.history.root(), key, diff.patch);
    const handoff = await this.history.latestBody(key, 'handoff');
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
      return closeReview(ctx, 'failed', 1, `${opened.startedAt} ${errors[0]}`, stored, [], undefined);
    }
    const noted = await noteHandoff(this.history, key, opinions, stored);
    if (only && othersOpen(only, opinions)) {
      const summary = opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
      return closeReview(
        ctx,
        'waiting',
        0,
        `${opened.startedAt} code-review waiting\n${summary}`,
        noted,
        [],
        undefined,
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
        'failed',
        1,
        `${opened.startedAt} ${written.error}`,
        noted,
        reportExchanges,
        undefined,
        written.usage,
      );
    }
    const recorded = [...noted, written.document];
    if (fresh) {
      recorded.push(textDocument(REBASE_CONFLICT, 'clear\n'));
    }
    return routeReview(
      this.history,
      ctx,
      opinions,
      recorded,
      written.exchange ? [written.exchange] : [],
      thirdParty,
      written.usage,
    );
  }
}

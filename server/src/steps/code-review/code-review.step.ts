import { Inject, Injectable } from '@nestjs/common';
import { realpathSync } from 'fs';
import { AppConfig, SwarmloopEnv } from '../../config/env';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { EventRepository } from '../../history/event.repository';
import { FlowRepository } from '../../history/flow.repository';
import { root } from '../../history/run-paths';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
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
import { ARTIFACTS } from '../contract/artifacts';

@Injectable()
export class CodeReviewStep extends BaseStep {
  readonly name: StepName = 'code-review';
  readonly requiredKind = ARTIFACTS.implementation.kind;
  override readonly usesModel = true;
  readonly acceptsPath = true;

  constructor(
    runs: RunRepository,
    documents: DocumentRepository,
    visits: VisitRepository,
    flows: FlowRepository,
    clock: Clock,
    config: AppConfig,
    private readonly checkouts: CheckoutRepository,
    private readonly events: EventRepository,
    private readonly prepare: PrepareStep,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {
    super(runs, documents, visits, flows, clock, config);
  }

  override async missingInput(key: string, options: StepOptions): Promise<string | null> {
    if (
      options.path ||
      (await storedCheckout(this.runs, this.documents, key)) ||
      (await foreignReviewOf(this.runs, this.flows, key))
    ) {
      return null;
    }
    return requiredDocument(this.documents, key, this.requiredKind);
  }

  charge(key: string, env: SwarmloopEnv, prices: Record<string, ModelPrice>): Promise<Charge | null> {
    return chargeReview(root(this.config), key, env, prices);
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
    const deps = {
      documents: this.documents,
      visits: this.visits,
      root: root(this.config),
      agent: this.agent,
    };
    const notes = await this.documents.latestBody(key, ARTIFACTS.implementation.kind);
    const checkout = options.path ?? (notes?.trim() ? null : opened.run.targetPath);
    let thirdParty = Boolean(checkout);
    if (!thirdParty && !notes?.trim()) {
      if (!(await foreignReview(this.flows, opened.run.id))) {
        throw new SwarmloopError('implementation is missing');
      }
      await detachForeign(this.documents, this.prepare, opened);
      thirdParty = true;
    }
    if (checkout) {
      opened.run.targetPath = realpathSync(checkout);
    }
    const requirements =
      ((await this.documents.latestBody(key, ARTIFACTS.requirements.kind)) ?? '').trim() || opened.run.prompt || '';
    if (!thirdParty && !requirements.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const mounts = checkout ? pathMount(checkout) : await repoMounts(this.runs, this.documents, root(this.config), key);
    const only = REVIEWERS.some((item) => item.name === options.reviewer) ? options.reviewer : undefined;
    const fresh = ((await this.documents.latestBody(key, ARTIFACTS.rebaseConflict.kind)) ?? '').trim() === 'review';
    const retry = fresh ? false : await retrying(this.visits, opened);
    const returned = composedReturn(await this.documents.listDocuments(opened.run.id));
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
      return closeReview(ctx, 'failed', 1, `${opened.startedAt} code-review does not fit`, [], []);
    }
    writeReviewDiff(root(this.config), key, diff.patch);
    const handoff = await this.documents.latestBody(key, ARTIFACTS.handoff.kind);
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
    const noted = await noteHandoff(this.documents, key, opinions, stored);
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

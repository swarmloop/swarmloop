import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { realpathSync } from 'fs';
import { readEnv, SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, ExchangeDraft } from '../../history/visit';
import { AGENT_RUNNER, AgentProcessRunner } from '../../limits/agent-runner';
import { PipelineResult, StepName, StepOptions, visitStatus } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { approvedChecklist } from './code-review.prompts';
import { composedReturn, mergeHandoff, returnNotes, textDocument } from '../shared/handoff';
import { plainSummary, summaryOr } from '../shared/skill-prompt';
import { readPlan } from '../plan/plan-record';
import { PrepareService } from '../prepare/prepare.service';
import { Step, requiredDocument } from '../step';
import { REBASE_CONFLICT } from '../../git/rebase-worktree';
import { reviewDiffSection, writeReviewDiff } from './review-diff';
import { decidedOk, Opinion, REVIEWERS, Reviewer, Usage } from './reviewer';
import { detachForeign, foreignReview, foreignReviewOf, pathMount, repoMounts, retrying, storedCheckout } from './review-input';
import { writeReport } from './review-report';
import { acceptRepeated, reviewReturn, runRound, sameReviewedDiff, selectReviewers } from './review-round';

@Injectable()
export class CodeReviewService implements Step {
  readonly name: StepName = 'code-review';
  readonly usesModel = true;

  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly prepare: PrepareService,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {}

  async missingInput(key: string, options: StepOptions): Promise<string | null> {
    if (options.path || (await storedCheckout(this.history, key)) || (await foreignReviewOf(this.history, key))) {
      return null;
    }
    return requiredDocument(this.history, key, 'implementation');
  }

  execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    return this.run(key, options, readEnv(this.config));
  }

  private async run(key: string, options: StepOptions, env: SwarmloopEnv): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'code-review');
    if (options.path) {
      opened.run.targetPath = realpathSync(options.path);
    }
    try {
      await this.sandbox.assertReady(env.RUNTIME);
      return await this.review(key, opened, options, env);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'code-review failed';
      return this.finish(opened, 'failed', 1, `${opened.startedAt} ${message}`, [], []);
    }
  }

  private async review(key: string, opened: OpenedStep, options: StepOptions, env: SwarmloopEnv): Promise<PipelineResult> {
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
    const { kept, pending, recovered, stale } = await selectReviewers(this.history, { key, only, fresh, retry, same, repeated });
    const calls = pending.length + (this.reportDue(only, kept, pending) ? 1 : 0);
    if (options.auto && calls > 0 && opened.run.agentCalls + calls > env.MAX_AGENT_CALLS) {
      return this.finish(opened, 'failed', 1, `${opened.startedAt} code-review does not fit`, [], []);
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
    const reportContinued = finished.some((item) => Boolean(item.result?.chatId));
    const drafted = [...recovered, ...finished.flatMap((item) => (item.parsed ? [textDocument(item.reviewer.kind, item.parsed.body)] : []))];
    const found = this.ordered([...kept, ...finished.flatMap((item) => (item.parsed ? [item.parsed] : []))]);
    const opinions = repeated
      ? found.map((item) => (item.decision === 'return' ? { ...item, decision: 'ok' as const, body: decidedOk(item.body) } : item))
      : found;
    const stored = repeated ? acceptRepeated(drafted, found) : drafted;
    const errors = finished.flatMap((item) => (item.error ? [item.error] : []));
    const none: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] };
    if (errors.length > 0) {
      return this.finish(opened, 'failed', 1, `${opened.startedAt} ${errors[0]}`, stored, [], undefined, none);
    }
    const noted = await this.noted(key, opinions, stored);
    if (only && this.othersOpen(only, opinions)) {
      const summary = opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
      return this.finish(opened, 'waiting', 0, `${opened.startedAt} code-review waiting\n${summary}`, noted, [], undefined, none);
    }
    const written = await writeReport(deps, opened, key, env, opinions, mounts, requirements, notes, reportContinued, options.auto);
    const reportExchanges = written.exchange ? [written.exchange] : [];
    if ('error' in written) {
      return this.finish(opened, 'failed', 1, `${opened.startedAt} ${written.error}`, noted, reportExchanges, undefined, written.usage);
    }
    const recorded = [...noted, written.document];
    if (fresh) {
      recorded.push(textDocument(REBASE_CONFLICT, 'clear\n'));
    }
    return this.route(opened, opinions, recorded, written.exchange ? [written.exchange] : [], thirdParty, written.usage);
  }

  private async route(
    opened: OpenedStep,
    opinions: Opinion[],
    documents: DocumentDraft[],
    exchanges: ExchangeDraft[],
    thirdParty: boolean,
    usage: Usage,
  ): Promise<PipelineResult> {
    const summary = opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
    const line = `${opened.startedAt} code-review waiting\n${summary}`;
    const returning = opinions.filter((item) => item.decision === 'return');
    if (returning.length === 0 || thirdParty) {
      return this.finish(opened, 'ok', 0, `${opened.startedAt} code-review done\n${summary}`, documents, exchanges, undefined, usage);
    }
    opened.run.attemptsReview += 1;
    await this.history.recordLoop(opened.run, 'review', opened.run.attemptsReview, returning.map((item) => item.kind).join(','));
    const report = documents.find((item) => item.kind === 'review_report')?.body.trim();
    const leftover = report
      ? textDocument('return', report.endsWith('\n') ? report : `${report}\n`)
      : returnNotes(returning.map((item) => ({ source: item.kind.replace(/^review_/, ''), body: item.body })));
    return this.finish(opened, 'waiting', 0, line, [...documents, leftover], exchanges, 'implement', usage);
  }

  private ordered(opinions: Opinion[]): Opinion[] {
    return REVIEWERS.flatMap((reviewer) => opinions.filter((item) => item.kind === reviewer.kind));
  }

  private async noted(key: string, opinions: Opinion[], documents: DocumentDraft[]): Promise<DocumentDraft[]> {
    if (opinions.length === 0) {
      return documents;
    }
    let text = (await this.history.latestBody(key, 'handoff')) ?? '';
    for (const opinion of opinions) {
      const step = opinion.kind.replace(/^review_/, '');
      text = mergeHandoff(text, step, summaryOr(opinion.body, plainSummary(opinion.body) || `- ${opinion.decision}`));
    }
    return [...documents, textDocument('handoff', text)];
  }

  private reportDue(only: string | undefined, kept: Opinion[], pending: Reviewer[]): boolean {
    const covered = new Set([...kept.map((item) => item.kind), ...pending.map((item) => item.kind)]);
    return REVIEWERS.every((reviewer) => covered.has(reviewer.kind));
  }

  private othersOpen(only: string, opinions: Opinion[]): boolean {
    return REVIEWERS.some((reviewer) => {
      if (reviewer.name === only) {
        return false;
      }
      const opinion = opinions.find((item) => item.kind === reviewer.kind);
      return !opinion || opinion.decision === 'return';
    });
  }

  private finish(
    opened: OpenedStep,
    outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
    exitCode: number,
    line: string,
    documents: DocumentDraft[],
    exchanges: ExchangeDraft[],
    moveTo?: 'implement',
    usage: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] },
  ): Promise<PipelineResult> {
    const now = new Date().toISOString();
    return closeStep({
      history: this.history,
      run: opened.run,
      previousStep: opened.previousStep,
      previousStatus: opened.previousStatus,
      step: 'code-review',
      outcome,
      exitCode,
      line,
      moveTo,
      visit: {
        step: 'code-review',
        model: exchanges.find((exchange) => exchange.model)?.model ?? null,
        mode: 'ask',
        startedAt: opened.startedAt,
        finishedAt: now,
        durationMs: Date.now() - opened.started,
        status: visitStatus(outcome),
        exitCode,
        killReason: exchanges.find((exchange) => exchange.killReason)?.killReason ?? null,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        usd: usage.usd,
        samples: usage.samples,
        exchange: null,
        exchanges,
        httpCalls: [],
        document: null,
        documents,
        resumed: false,
      },
    });
  }
}

function approvedPlan(requirements: string): string {
  const plan = readPlan(requirements);
  if (!plan || plan.decision !== 'approve' || plan.items.length === 0) {
    return '';
  }
  return approvedChecklist(plan.items);
}

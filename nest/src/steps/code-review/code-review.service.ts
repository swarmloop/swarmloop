import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { readEnv, SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, ExchangeDraft, SampleDraft } from '../../history/visit';
import { AGENT_RUNNER, AgentProcessRunner, AgentRunResult, readSession } from '../../limits/agent-runner';
import { sessionFileName } from '../../limits/session-group';
import { PipelineResult, StepOptions, visitStatus } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { agentStateDir, SandboxMount } from '../../sandbox/sandbox-launch';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { liveLogBody } from '../../acp/live-output';
import { reportFollowUp, reviewContinue, reviewResume } from '../follow-up';
import { withReturnNotes } from '../implement/implement-record';
import { agentFailure, combineAgentResults, composedReturn, handoffSection, launchAgent, mergeHandoff, plainSummary, returnNotes, skillPrompt, summaryOr, textDocument, withHandoff } from '../model-step';
import { storedProjects } from '../prepare/checkout-path';
import { readPlan } from '../plan/plan-record';
import { PrepareService } from '../prepare/prepare.service';
import { mountsForStep, repoNames } from '../repo-names';
import { REBASE_CONFLICT } from '../rebase-worktree';
import { parseReview } from './code-review-record';
import { reviewBrief } from './review-report';
import { reviewDiffSection, writeReviewDiff } from './review-diff';

interface Reviewer {
  name: string;
  kind: string;
}

interface Opinion {
  kind: string;
  decision: 'ok' | 'return';
  body: string;
}

interface Finished {
  reviewer: Reviewer;
  model: string;
  prompt: string;
  result: AgentRunResult | null;
  parsed?: Opinion;
  error?: string;
}

export const REVIEWERS: Reviewer[] = [
  { name: 'requirements', kind: 'review_requirements' },
  { name: 'quality', kind: 'review_quality' },
  { name: 'regressions', kind: 'review_regressions' },
  { name: 'security', kind: 'review_security' },
  { name: 'performance', kind: 'review_performance' },
];

@Injectable()
export class CodeReviewService {
  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly prepare: PrepareService,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {}

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
    const notes = await this.history.latestBody(key, 'implementation');
    const checkout = options.path ?? (notes?.trim() ? null : opened.run.targetPath);
    let thirdParty = Boolean(checkout);
    if (!thirdParty && !notes?.trim()) {
      if (!(await this.foreignReview(opened.run.id))) {
        throw new SwarmloopError('implementation is missing');
      }
      await this.detachForeign(opened);
      thirdParty = true;
    }
    if (checkout) {
      opened.run.targetPath = realpathSync(checkout);
    }
    const requirements = ((await this.history.latestBody(key, 'requirements')) ?? '').trim() || opened.run.prompt || '';
    if (!thirdParty && !requirements.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const mounts = checkout ? this.pathMount(checkout) : await this.repoMounts(key);
    const only = REVIEWERS.some((item) => item.name === options.reviewer) ? options.reviewer : undefined;
    const fresh = ((await this.history.latestBody(key, REBASE_CONFLICT)) ?? '').trim() === 'review';
    const retry = fresh ? false : await this.retrying(opened);
    const returned = composedReturn(await this.history.listDocuments(opened.run.id));
    const diff = await reviewDiffSection(mounts, await this.history.listDenyPaths());
    const same = sameReviewedDiff(this.history.root(), key, diff.patch);
    const repeated = reviewReturn(returned) && same;
    const kept: Opinion[] = [];
    const pending: Reviewer[] = [];
    const recovered: DocumentDraft[] = [];
    const stale = new Set<string>();
    for (const reviewer of REVIEWERS) {
      if (fresh) {
        if (!only || only === reviewer.name) {
          pending.push(reviewer);
        }
        continue;
      }
      if (only === reviewer.name) {
        pending.push(reviewer);
        continue;
      }
      const stored = !fresh && (Boolean(only) || retry || same) ? await this.history.latestBody(key, reviewer.kind) : null;
      if (stored) {
        try {
          const parsed = parseReview(stored);
          if (staleReturn(repeated, parsed.decision)) {
            stale.add(reviewer.name);
          } else if (only || retry || parsed.decision === 'ok') {
            kept.push({ kind: reviewer.kind, decision: parsed.decision, body: stored });
            continue;
          }
        } catch {
          // launch or leave open
        }
      }
      if (retry && !only) {
        try {
          const parsed = parseReview(liveLogBody(this.history.root(), key, `code-review-${reviewer.name}`));
          if (staleReturn(repeated, parsed.decision)) {
            stale.add(reviewer.name);
          } else {
            kept.push({ kind: reviewer.kind, decision: parsed.decision, body: parsed.body });
            recovered.push(textDocument(reviewer.kind, parsed.body));
            continue;
          }
        } catch {
          // launch this reviewer again
        }
      }
      if (!only) {
        pending.push(reviewer);
      }
    }
    const calls = pending.length + (this.reportDue(only, kept, pending) ? 1 : 0);
    if (options.auto && calls > 0 && opened.run.agentCalls + calls > env.MAX_AGENT_CALLS) {
      return this.finish(opened, 'failed', 1, `${opened.startedAt} code-review does not fit`, [], []);
    }
    writeReviewDiff(this.history.root(), key, diff.patch);
    const handoff = await this.history.latestBody(key, 'handoff');
    const plan = approvedPlan(requirements);
    const jobs = pending.map((reviewer) => ({ ...this.job(reviewer, env, requirements, notes, mounts, handoff, returned, diff, plan), stale: stale.has(reviewer.name) }));
    const fix = fixNotes(await this.history.listDocuments(opened.run.id), handoff);
    const finished = await Promise.all(jobs.map((job) => this.runJob(opened, key, env, job, fix, plan, options.auto, fresh, retry)));
    for (const item of finished) {
      await this.recordAngle(opened, item, repeated);
    }
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
    const written = await this.writeReport(opened, key, env, opinions, mounts, requirements, notes, reportContinued, options.auto);
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
    const leftover = returnNotes(returning.map((item) => ({ source: item.kind.replace(/^review_/, ''), body: item.body })));
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

  private job(
    reviewer: Reviewer,
    env: SwarmloopEnv,
    requirements: string,
    notes: string | null,
    mounts: SandboxMount[],
    handoff: string | null,
    returned: string | null,
    diff: { heading: string; body: string },
    plan: string,
  ) {
    const names = mounts.map((mount) => basename(mount.hostPath));
    const notesSection = notes?.trim() ? [{ heading: 'Implementation', body: notes }] : [];
    const planSection = plan.trim() ? [{ heading: 'Plan', body: plan }] : [];
    const sections = withHandoff(withReturnNotes([diff, ...notesSection, ...planSection], returned), handoff);
    return {
      reviewer,
      model: env.MODEL_PLAN,
      prompt: skillPrompt(`code-review/${reviewer.name}`, requirements, names, sections, mounts),
      mounts,
    };
  }

  private reportDue(only: string | undefined, kept: Opinion[], pending: Reviewer[]): boolean {
    const covered = new Set([...kept.map((item) => item.kind), ...pending.map((item) => item.kind)]);
    return REVIEWERS.every((reviewer) => covered.has(reviewer.kind));
  }

  private async writeReport(
    opened: OpenedStep,
    key: string,
    env: SwarmloopEnv,
    opinions: Opinion[],
    mounts: SandboxMount[],
    requirements: string,
    implementation: string | null,
    continued: boolean,
    auto?: boolean,
  ): Promise<{ document: DocumentDraft; exchange: ExchangeDraft; usage: Usage } | { error: string; exchange: ExchangeDraft | null; usage: Usage }> {
    const names = mounts.map((mount) => basename(mount.hostPath));
    const brief = reviewBrief(opinions);
    const sections = [
      ...(implementation?.trim() ? [{ heading: 'Implementation', body: implementation }] : []),
      { heading: 'Reviews', body: brief },
    ];
    const prompt = continued
      ? reportFollowUp(brief, implementation)
      : skillPrompt('code-review/report', requirements, names, sections, mounts);
    const model = env.MODEL_PLAN;
    const empty: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] };
    try {
      const directory = join(this.history.root(), 'data');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${key}-code-review-report-output.txt`), 'starting\n');
      const result = await launchAgent({
        agent: this.agent,
        history: this.history,
        run: opened.run,
        key,
        step: 'code-review-report',
        mode: 'ask',
        model,
        timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
        prompt,
        workspace: mounts[0]?.containerPath ?? '/work',
        mounts,
        auto,
        resume: false,
      });
      const exchange: ExchangeDraft = {
        model,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        requestText: prompt,
        responseText: result.responseText,
        chatId: result.chatId,
        resumed: result.resumed,
        killReason: result.killReason,
      };
      const spent: Usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, usd: result.usd, samples: result.samples };
      const failure = agentFailure(result, 'code-review');
      if (failure) {
        return { error: failure, exchange, usage: spent };
      }
      const text = result.responseText.trim();
      if (!text) {
        return { error: 'code-review report is empty', exchange, usage: spent };
      }
      return { document: textDocument('review_report', `${text}\n`), exchange, usage: spent };
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'code-review failed';
      return { error: message, exchange: null, usage: empty };
    }
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

  private async runJob(
    opened: OpenedStep,
    key: string,
    env: SwarmloopEnv,
    job: { reviewer: Reviewer; model: string; prompt: string; mounts: SandboxMount[]; stale: boolean },
    fix: { implement: string; reviewed: string },
    plan: string,
    auto: boolean | undefined,
    fresh: boolean,
    retry: boolean,
  ): Promise<Finished> {
    const step = `code-review-${job.reviewer.name}`;
    const session = await readSession(join(this.history.root(), 'data', sessionFileName(key, step)));
    const prompt = fresh || !session?.chatId
      ? job.prompt
      : retry && !job.stale
        ? reviewContinue(job.reviewer.name)
        : reviewResume(job.reviewer.name, fix.implement, fix.reviewed, plan);
    return this.one(opened, key, env, { reviewer: job.reviewer, model: job.model, prompt, mounts: job.mounts }, auto, fresh);
  }

  /** One reviewer visit, with its own chart and exchange, the same shape as any other step. */
  private async recordAngle(opened: OpenedStep, item: Finished, repeated = false): Promise<void> {
    const result = item.result;
    if (!result) {
      return;
    }
    const parsed = item.parsed && repeated && item.parsed.decision === 'return'
      ? { ...item.parsed, decision: 'ok' as const, body: decidedOk(item.parsed.body) }
      : item.parsed;
    const status = item.error ? 'failed' : parsed?.decision === 'return' ? 'waiting' : parsed ? 'done' : 'failed';
    const exchange = this.exchange(item);
    const log = result.output ? (result.output.endsWith('\n') ? result.output : `${result.output}\n`) : '';
    await this.history.finishVisit(opened.run, {
      step: `code-review-${item.reviewer.name}`,
      model: item.model,
      mode: 'ask',
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      status,
      exitCode: item.error ? 1 : 0,
      killReason: result.killReason ? `process killed: ${result.killReason}` : null,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      usd: result.usd,
      samples: result.samples,
      exchange,
      httpCalls: [],
      document: null,
      documents: [
        ...(parsed ? [textDocument(item.reviewer.kind, parsed.body)] : []),
        ...(item.error ? [{ kind: 'error', fileName: '', body: `${item.error}\n` }] : []),
        ...(log ? [{ kind: 'log', fileName: '', body: log }] : []),
      ],
      resumed: result.resumed,
    });
  }

  private async one(
    opened: OpenedStep,
    key: string,
    env: SwarmloopEnv,
    job: { reviewer: Reviewer; model: string; prompt: string; mounts: SandboxMount[] },
    auto?: boolean,
    fresh = false,
  ): Promise<Finished> {
    try {
      const directory = join(this.history.root(), 'data');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${key}-code-review-${job.reviewer.name}-output.txt`), 'starting\n');
      const result = await this.launchReview(opened, key, env, job, auto, fresh);
      const failure = agentFailure(result, 'code-review');
      if (failure) {
        return { reviewer: job.reviewer, model: job.model, prompt: job.prompt, result, error: failure };
      }
      const parsed = parseReview(result.responseText, result.output ?? '');
      return {
        reviewer: job.reviewer,
        model: job.model,
        prompt: job.prompt,
        result,
        parsed: { kind: job.reviewer.kind, decision: parsed.decision, body: parsed.body },
      };
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'code-review failed';
      return { reviewer: job.reviewer, model: job.model, prompt: job.prompt, result: null, error: message };
    }
  }

  private async launchReview(
    opened: OpenedStep,
    key: string,
    env: SwarmloopEnv,
    job: { reviewer: Reviewer; model: string; prompt: string; mounts: SandboxMount[] },
    auto?: boolean,
    fresh = false,
  ): Promise<AgentRunResult> {
    const step = `code-review-${job.reviewer.name}`;
    const workspace = job.mounts[0]?.containerPath ?? '/work';
    let prompt = job.prompt;
    let folded: AgentRunResult | null = null;
    for (let attempt = 0; attempt < env.MAX_LAUNCHES; attempt += 1) {
      if (attempt > 0 && auto && opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
        break;
      }
      const result = await launchAgent({
        agent: this.agent,
        history: this.history,
        run: opened.run,
        key,
        step,
        mode: 'ask',
        model: job.model,
        timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
        prompt,
        workspace,
        mounts: job.mounts,
        auto,
        resume: fresh && attempt === 0 ? false : undefined,
      });
      folded = folded
        ? {
            ...result,
            tokensIn: folded.tokensIn + result.tokensIn,
            tokensOut: folded.tokensOut + result.tokensOut,
            usd: folded.usd + result.usd,
            calls: folded.calls + result.calls,
            samples: [...folded.samples, ...result.samples],
            durationMs: folded.durationMs + result.durationMs,
            output: combineAgentResults([folded, result])?.output,
          }
        : result;
      if (result.killReason !== 'time' && result.killReason !== 'idle') {
        return folded;
      }
      prompt = result.chatId ? reviewContinue(job.reviewer.name) : job.prompt;
    }
    if (!folded) {
      throw new SwarmloopError('code-review failed');
    }
    return folded;
  }

  private exchange(item: Finished): ExchangeDraft {
    const result = item.result;
    if (!result) {
      throw new SwarmloopError('code-review failed');
    }
    return {
      model: item.model,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      requestText: item.prompt,
      responseText: result.responseText,
      chatId: result.chatId,
      resumed: result.resumed,
      killReason: result.killReason,
    };
  }

  private async foreignReview(runId: number): Promise<boolean> {
    return !(await this.history.activePhases(runId)).includes('implementation');
  }

  private async detachForeign(opened: OpenedStep): Promise<void> {
    const names = storedProjects(opened.run.projects);
    if (names.length === 0) {
      throw new SwarmloopError('projects is missing');
    }
    await this.prepare.ensureDetached(opened.run, names, opened.run.prompt, true);
    await this.history.putDocument(opened.run, 'repos', `${names.join('\n')}\n`);
  }

  private async repoMounts(key: string): Promise<SandboxMount[]> {
    const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
    const run = await this.history.findRun(key);
    return mountsForStep(this.history.root(), key, names, run?.targetPath ?? null).map((mount) => ({ ...mount, readonly: true }));
  }

  private pathMount(path: string): SandboxMount[] {
    return [{ hostPath: realpathSync(path), containerPath: '/work', readonly: true }];
  }

  private async retrying(opened: OpenedStep): Promise<boolean> {
    if (opened.previousStep !== 'code-review') {
      return false;
    }
    if (['failed', 'running', 'blocked'].includes(opened.previousStatus)) {
      return true;
    }
    if (opened.previousStatus !== 'waiting') {
      return false;
    }
    const last = [...(await this.history.listStats(opened.run.id))].reverse().find((item) => item.step === 'code-review');
    return last?.status === 'failed' || last?.status === 'blocked';
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

const REVIEW_ANGLES = ['requirements', 'quality', 'regressions', 'security', 'performance'];

function approvedPlan(requirements: string): string {
  const plan = readPlan(requirements);
  if (!plan || plan.decision !== 'approve' || plan.items.length === 0) {
    return '';
  }
  return [
    'This is the approved checklist. A behavior it removes is not a missing requirement.',
    'On a later pass, decision: ok when the last return is already what this checklist asks, even when the files were left unchanged. Do not return that behavior again.',
    ...plan.items.map((item) => `- ${item}`),
  ].join('\n');
}

function staleReturn(repeated: boolean, decision: 'ok' | 'return'): boolean {
  return repeated && decision === 'return';
}

function reviewReturn(returned: string | null): boolean {
  if (!returned) {
    return false;
  }
  return REVIEW_ANGLES.some((name) => returned.includes(`## ${name}`));
}

function sameReviewedDiff(root: string, key: string, patch: string): boolean {
  try {
    const previous = readFileSync(join(agentStateDir(root, key, 'code-review-requirements'), 'briefs', 'diff.md'), 'utf8');
    return previous === patch;
  } catch {
    return false;
  }
}

function decidedOk(body: string): string {
  const lines = body.split('\n').filter((line) => line.trim() !== 'decision: return');
  return `${lines.join('\n').trimEnd()}\ndecision: ok\n`;
}

function acceptRepeated(documents: DocumentDraft[], opinions: Opinion[]): DocumentDraft[] {
  const kinds = new Set(opinions.filter((item) => item.decision === 'return').map((item) => item.kind));
  return documents.map((document) => (kinds.has(document.kind) ? { ...document, body: decidedOk(document.body) } : document));
}

function fixNotes(documents: { kind: string; body: string }[], handoff: string | null): { implement: string; reviewed: string } {
  const written = documents.filter((item) => item.kind === 'implementation' && item.body.trim()).map((item) => item.body.trim());
  const implementWhat = written.length >= 2 ? written[written.length - 2] : (written.at(-1) ?? '');
  const reviewWhat = written.length >= 2 ? (written.at(-1) ?? '') : '';
  const same = reviewWhat.length > 0 && reviewWhat === implementWhat;
  return {
    implement: passNote(implementWhat, handoffSection(handoff, 'implement')),
    reviewed: passNote(same ? '' : reviewWhat, handoffSection(handoff, 'implement-review')),
  };
}

function passNote(what: string, why: string): string {
  const parts = [
    what.trim() ? `What was done:\n${what.trim()}` : '',
    why.trim() ? `Why:\n${why.trim()}` : '',
  ];
  return parts.filter((part) => part.length > 0).join('\n');
}

interface Usage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
  samples: SampleDraft[];
}

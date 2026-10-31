import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { DocumentEntity, RunEntity, StepStatEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { Charge, chargeStream, modelForStep } from '../limits/spend';
import { loadPriceTable } from '../limits/prices';
import { LiveHub, LiveSpend } from '../live/live.hub';
import { liveLogBody, liveLogCurrent } from '../acp/live-output';
import { PipelineService } from '../pipeline/pipeline.service';
import { assertKey, isReviewStep, isStep, nextSessionKey, normalizePhases, PhaseName, pipelineStepOf, reviewerOf, ticketKey } from '../pipeline/pipeline-result';
import { branchName, commitMessage, summaryForBranch } from '../steps/branch/branch-name';
import { REBASE_MERGE_SKIP } from '../steps/merge-request/merge-request.service';
import { REBASE_CONFLICT, rebaseFeatureRepos } from '../git/rebase-worktree';
import { repoNames } from '../steps/repo-names';
import { parsePaths } from '../steps/commit/commit-paths';
import { CHECKOUT_NAME, renderProjects, storedProjects } from '../steps/prepare/checkout-path';
import { PrepareService } from '../steps/prepare/prepare.service';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { SwarmloopError } from '../swarmloop-error';
import { taskKeys } from '../steps/requirements/requirements.service';
import { reviewDecision } from '../steps/code-review/code-review-record';
import { RunSummary, FlowView, REVIEW_KINDS, STEP_KINDS } from './run-view/run-view.types';
import { angleVerdict, decisionLine, reviewerOutcome } from './run-view/chips';
import { latest, metrics, openItems, phases, reason, resumeState, returns, runName, sentence, withSkip } from './run-view/flow';
import { belongsToVisit, documentView, filesOf, withReturnNotes } from './run-view/documents';
import { launchView, liveVisit } from './run-view/live';

@Injectable()
export class RunsService {
  constructor(
    private readonly history: HistoryService,
    private readonly pipeline: PipelineService,
    private readonly projects: ProjectAppendService,
    private readonly prepare: PrepareService,
    private readonly config: ConfigService,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async list(): Promise<{ runs: RunSummary[] }> {
    const runs = await this.history.listRuns();
    const durations = await this.history.durationByRun();
    return {
      runs: runs.map((run) => ({
        key: run.key,
        name: runName(run.key, run.prompt),
        status: run.status,
        currentStep: run.currentStep,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        stepStartedAt: run.stepStartedAt,
        durationMs: durations.get(run.id) ?? 0,
        usd: run.spentUsd + this.openSpend(run).usd,
      })),
    };
  }

  async addProject(key: string, name: string): Promise<{ projects: string[]; applied: boolean }> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('name is missing');
    }
    await this.requireRun(key);
    try {
      return await this.projects.add(key, trimmed);
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async flow(key: string): Promise<FlowView> {
    const run = await this.requireRun(key);
    const documents = await this.history.listDocuments(run.id);
    const stats = await this.history.listStats(run.id);
    const pastes = await this.history.listPastes(key);
    const launches = await this.history.listFlows(run.id);
    const open = openItems(run, documents, pastes.map((paste) => paste.url));
    const shown = this.pipeline.claimed(run.key) && run.status !== 'done' ? ({ ...run, status: 'running' } as RunEntity) : run;
    const resume = resumeState(shown, open, documents);
    const maxReturns = readEnv(this.config).MAX_RETURNS;
    const reportMs = await this.history.codeReviewReportMs(run.id);
    return {
      key: run.key,
      name: runName(run.key, run.prompt),
      status: shown.status,
      currentStep: run.currentStep,
      updatedAt: run.updatedAt,
      stepStartedAt: run.stepStartedAt,
      resume,
      sentence: withSkip(sentence(shown, open, documents, stats, maxReturns), shown.currentStep, latest(documents, 'ci_skip')),
      metrics: metrics(shown, stats, this.openSpend(shown), this.live?.peaksOf(run.key) ?? { cpuPeak: 0, memPeak: 0 }, reportMs),
      phases: phases(shown, stats, documents, this.history.root()),
      returns: returns(shown),
      items: open,
      paths: run.currentStep === 'commit' ? parsePaths(latest(documents, 'commit') ?? '') : [],
      reason: reason(shown, documents, stats),
      launches: launches.map(launchView),
      projects: storedProjects(renderProjects([...storedProjects(run.projects), ...storedProjects(latest(documents, 'pending_repos'))])),
    };
  }

  async step(key: string, name: string) {
    if (isReviewStep(name)) {
      return this.reviewerStep(key, name);
    }
    if (!isStep(name)) {
      throw new BadRequestException(`${name} is unknown`);
    }
    const run = await this.requireRun(key);
    const documents = await this.history.listDocuments(run.id);
    const stats = (await this.history.listStats(run.id)).filter((stat) => stat.step === name);
    const exchanges = await this.history.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.history.listSamples(stats.map((stat) => stat.id));
    const kinds = [...(STEP_KINDS[name] ?? []), 'error', 'log'];
    const visits = stats.map((stat, index) => {
      const owned = documents.filter((document) => document.stepStatId === stat.id);
      const verdict = name === 'code-review' ? angleVerdict(owned.filter((document) => (REVIEW_KINDS as readonly string[]).includes(document.kind)).map((document) => document.body)) : null;
      return {
        id: stat.id,
        attempt: stat.attempt,
        status: verdict === 'ok' ? 'done' : verdict === 'return' ? 'waiting' : stat.status,
        model: stat.model,
        mode: stat.mode,
        durationMs: stat.durationMs,
        tokensIn: stat.tokensIn,
        tokensOut: stat.tokensOut,
        usd: stat.usd,
        cpuAvg: stat.cpuAvg,
        cpuPeak: stat.cpuPeak,
        memAvg: stat.memAvg,
        memPeak: stat.memPeak,
        killReason: stat.killReason,
        decision: verdict ? `decision: ${verdict}` : decisionLine(owned.map((document) => document.body).join('\n')),
        documents: documents
          .filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1))
          .map(documentView),
        exchanges: exchanges
          .filter((exchange) => exchange.stepStatId === stat.id)
          .map((exchange) => ({
            model: exchange.model,
            durationMs: exchange.durationMs,
            request: exchange.requestText,
            response: exchange.responseText,
          })),
        samples: samples
          .filter((sample) => sample.stepStatId === stat.id)
          .map((sample) => ({ at: sample.sampledAt, cpu: sample.cpuPercent, memory: sample.rssBytes })),
      };
    });
    if (run.status === 'running' && run.currentStep === name) {
      visits.push(liveVisit(run.key, name, this.history.root(), stats.at(-1)?.attempt ?? 0, run.updatedAt));
    }
    return {
      step: name,
      visits: withReturnNotes(name, visits, documents),
      checks:
        name === 'code-review'
          ? REVIEW_KINDS.map((kind) => {
              const body = latest(documents, kind);
              return { name: kind.replace('review_', ''), decision: decisionLine(body ?? ''), body: body ?? '' };
            }).filter((check) => check.body !== '')
          : [],
    };
  }

  async readHistory(key: string) {
    const run = await this.requireRun(key);
    const documents = await this.history.listDocuments(run.id);
    const stats = await this.history.listStats(run.id);
    const exchanges = await this.history.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.history.listSamples(stats.map((stat) => stat.id));
    const loops = await this.history.listLoops(run.id);
    const calls = await this.history.listHttpCalls(run.id);
    const launches = await this.history.listFlows(run.id);
    return {
      launches: launches.map(launchView),
      documents: documents.map(documentView),
      files: filesOf(documents),
      exchanges: exchanges.map((exchange) => ({
        stepStatId: exchange.stepStatId,
        model: exchange.model,
        durationMs: exchange.durationMs,
        request: exchange.requestText,
        response: exchange.responseText,
      })),
      loops: loops.map((loop) => ({ counter: loop.counter, attempt: loop.attempt, reason: loop.reason, createdAt: loop.createdAt })),
      calls: calls.map((call) => ({
        method: call.method,
        url: call.url,
        statusCode: call.statusCode,
        durationMs: call.durationMs,
        error: call.error,
      })),
      samples: samples.map((sample) => ({ stepStatId: sample.stepStatId, at: sample.sampledAt, cpu: sample.cpuPercent, memory: sample.rssBytes })),
      stats: stats.map((stat) => ({
        id: stat.id,
        step: stat.step,
        attempt: stat.attempt,
        model: stat.model,
        durationMs: stat.durationMs,
        usd: stat.usd,
        tokensIn: stat.tokensIn,
        tokensOut: stat.tokensOut,
        cpuPeak: stat.cpuPeak,
        memPeak: stat.memPeak,
      })),
    };
  }

  async start(body: { key?: string; prompt?: string; path?: string; projects?: string[]; phases?: string[] }): Promise<{ http: number; body: { key: string; status: string } }> {
    const prompt = body.prompt?.trim() || undefined;
    const given = body.key?.trim() ?? '';
    if (!given && !prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const phases = this.phases(body.phases);
    let key = given || taskKeys(prompt ?? '', '')[0] || `run-${Date.now().toString(36)}`;
    try {
      assertKey(key);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'run id is invalid');
    }
    const path = body.path?.trim() || undefined;
    const opened = await this.openSession(key);
    key = opened.key;
    const existing = opened.run;
    if (!path && !prompt && !existing?.prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const projects = storedProjects(existing?.projects).length > 0 ? storedProjects(existing?.projects) : this.projectNames(body.projects);
    if (!path && projects.length === 0) {
      throw new BadRequestException('projects is missing');
    }
    if (!existing || (body.phases !== undefined && !this.history.held(existing))) {
      await this.history.noteFlow(key, phases, null);
    }
    const acceptsPrompt = !existing || existing.currentStep === 'requirements';
    if (prompt && (path || !acceptsPrompt)) {
      await this.rememberPrompt(key, prompt);
    }
    const result = path
      ? await this.pipeline.startDetached(key, { path, phases }, 'code-review')
      : await this.pipeline.startDetached(key, acceptsPrompt ? { prompt, projects, phases } : { projects, phases });
    return this.accepted(key, result);
  }

  async answers(key: string, body: { answers?: { kind?: string; id?: string; body?: string }[] }): Promise<FlowView> {
    const run = await this.requireRun(key);
    if (this.history.held(run)) {
      throw new ConflictException(`${key} is already running`);
    }
    const incoming = body.answers ?? [];
    const view = await this.flow(key);
    for (const item of view.items) {
      const found = incoming.find((answer) => answer.kind === item.kind && answer.id === item.id);
      if (!found?.body?.trim()) {
        throw new BadRequestException('answers are missing');
      }
    }
    const questions = incoming.filter((answer) => answer.kind === 'question' && answer.id && answer.body?.trim());
    if (questions.length > 0) {
      const text = questions.map((answer) => `question: ${answer.id}\nanswer: ${answer.body?.trim()}`).join('\n\n');
      await this.history.putDocument(run, 'answers', `${text}\n`);
    }
    for (const answer of incoming.filter((item) => item.kind === 'paste' && item.id && item.body?.trim())) {
      await this.history.savePaste(key, answer.id ?? '', answer.body?.trim() ?? '');
    }
    this.demandStart(await this.pipeline.startDetached(key));
    return this.flow(key);
  }

  async startStep(
    key: string,
    step: string,
    body: { prompt?: string; path?: string } = {},
  ): Promise<{ http: number; body: { key: string; status: string } }> {
    const name = pipelineStepOf(step);
    if (!isStep(name) || name === 'done') {
      throw new BadRequestException(`${step} is unknown`);
    }
    await this.requireRun(key);
    const prompt = body.prompt?.trim();
    const path = body.path?.trim();
    return this.accepted(
      key,
      await this.pipeline.startDetached(
        key,
        { prompt: prompt || undefined, path: path || undefined, reviewer: reviewerOf(step) },
        name,
      ),
    );
  }

  async replay(key: string, step: string, prompt: string, phases?: string[]): Promise<{ http: number; body: { key: string; status: string } }> {
    const name = pipelineStepOf(step);
    if (!isStep(name) || name === 'done') {
      throw new BadRequestException(`${step} is unknown`);
    }
    const text = prompt.trim();
    if (!text) {
      throw new BadRequestException('prompt is missing');
    }
    await this.requireRun(key);
    if (phases !== undefined) {
      await this.history.noteFlow(key, this.phases(phases), name);
    }
    return this.accepted(key, await this.pipeline.replay(key, name, text));
  }

  async stop(key: string): Promise<{ http: number; body: { key: string; status: string } }> {
    await this.requireRun(key);
    const result = await this.pipeline.stop(key);
    if (result.exitCode !== 0) {
      throw new ConflictException(result.message);
    }
    return { http: 200, body: { key, status: 'stopped' } };
  }

  async remove(key: string): Promise<{ key: string }> {
    try {
      assertKey(key);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'run id is invalid');
    }
    const run = await this.requireRun(key);
    const stopped = await this.pipeline.stop(key);
    if (stopped.exitCode !== 0) {
      throw new ConflictException(stopped.message);
    }
    await this.prepare.removeWorktrees(key);
    await this.history.remove(run);
    return { key };
  }

  async rebase(key: string): Promise<{ http: number; body: { key: string; status: string } }> {
    const run = await this.requireRun(key);
    if (run.status !== 'failed' && run.status !== 'done' && run.status !== 'waiting') {
      throw new ConflictException(`${key} is ${run.status}`);
    }
    const status = run.status;
    let stop: Awaited<ReturnType<typeof rebaseFeatureRepos>>;
    try {
      stop = await this.rebaseWorktrees(run);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'rebase failed';
      throw new ConflictException(message);
    }
    if (stop.kind === 'conflict') {
      const unfinished = await this.checklistUnfinished(run);
      await this.history.putDocument(run, REBASE_CONFLICT, unfinished ? 'pending-implement\n' : 'pending\n');
      return this.startAtImplement(run);
    }
    if (await this.checklistUnfinished(run)) {
      return this.startAtImplement(run);
    }
    if (status === 'failed' || status === 'waiting') {
      return this.resume(key);
    }
    const fresh = await this.requireRun(key);
    await this.history.putDocument(fresh, REBASE_MERGE_SKIP, 'skip\n');
    await this.history.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const next = await this.requireRun(key);
    next.currentStep = 'code-review';
    next.status = 'waiting';
    next.ownerPid = null;
    next.stepStartedAt = null;
    await this.history.saveRun(next);
    return this.accepted(key, await this.pipeline.startDetached(key));
  }

  async resume(key: string, prompt?: string): Promise<{ http: number; body: { key: string; status: string } }> {
    const view = await this.flow(key);
    if (view.resume === 'need-answers') {
      throw new BadRequestException('answers are missing');
    }
    if (view.resume === 'blocked') {
      throw new ConflictException('run is blocked');
    }
    if (view.resume === 'running') {
      throw new ConflictException(`${key} is already running`);
    }
    if (view.resume === 'done') {
      return { http: 200, body: { key, status: 'done' } };
    }
    return this.accepted(key, await this.pipeline.startDetached(key, prompt?.trim() ? { prompt: prompt.trim() } : {}));
  }

  /** New run always opens the next free session. Resume keeps the current one. */
  private async openSession(key: string): Promise<{ key: string; run: RunEntity | null }> {
    const ticket = ticketKey(key);
    const family = (await this.history.listRuns()).filter((run) => ticketKey(run.key) === ticket);
    const session = nextSessionKey(ticket, family.map((run) => run.key));
    return { key: session, run: await this.history.findRun(session) };
  }

  private phases(input?: string[]): PhaseName[] {
    try {
      return normalizePhases(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'phases are invalid');
    }
  }

  private projectNames(input?: string[]): string[] {
    const names = [...new Set((input ?? []).map((name) => name.trim()).filter((name) => name.length > 0))].sort();
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
        throw new BadRequestException(`${name} is not a project`);
      }
    }
    return names;
  }

  private async rememberPrompt(key: string, prompt: string): Promise<void> {
    const existing = await this.history.findRun(key);
    if (existing) {
      if (!this.history.held(existing)) {
        existing.prompt = prompt;
        await this.history.saveRun(existing);
      }
      return;
    }
    const created = await this.history.begin(key, 'code-review');
    created.status = 'waiting';
    created.ownerPid = null;
    created.prompt = prompt;
    created.stepStartedAt = null;
    await this.history.saveRun(created);
  }

  private openSpend(run: RunEntity): LiveSpend {
    const running = run.status === 'running' || this.pipeline.claimed(run.key);
    if (!running) {
      return { tokensIn: 0, tokensOut: 0, usd: 0 };
    }
    return this.live?.spendOf(run.key) ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
  }

  private async reviewerStep(key: string, name: string) {
    const run = await this.requireRun(key);
    const documents = await this.history.listDocuments(run.id);
    const own = (await this.history.listStats(run.id)).filter((stat) => stat.step === name);
    if (own.length > 0) {
      return this.angleStep(run, name, documents, own);
    }
    const stats = (await this.history.listStats(run.id)).filter((stat) => stat.step === 'code-review');
    const samples = await this.history.listSamples(stats.map((stat) => stat.id));
    const kind = `review_${name.slice('code-review-'.length)}`;
    const raw = liveLogBody(this.history.root(), key, name);
    const env = readEnv(this.config);
    const model = modelForStep(name, env);
    let charge: Charge | null = null;
    if (model && raw.trim() && raw !== 'waiting for output') {
      charge = chargeStream(model, raw, await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME));
    }
    const parentRunning = (run.status === 'running' || this.pipeline.claimed(run.key)) && run.currentStep === 'code-review';
    const open = parentRunning && liveLogCurrent(this.history.root(), key, name);
    const ownedStats = stats.filter((stat) => documents.some((document) => document.stepStatId === stat.id && document.kind === kind));
    const visits = ownedStats.map((stat, index) => {
      const latestDone = index === ownedStats.length - 1 && !parentRunning;
      const owned = documents.filter((document) => document.stepStatId === stat.id && document.kind === kind);
      const log = latestDone ? raw : '';
      const ownedText = owned.map((item) => item.body).join('\n');
      const verdict = reviewDecision(`${ownedText}\n${log}`);
      return {
        id: stat.id,
        attempt: index + 1,
        status: verdict === 'ok' ? 'done' : verdict === 'return' ? 'waiting' : reviewerOutcome(log, stat.status),
        model,
        mode: 'agent' as const,
        durationMs: stat.durationMs,
        tokensIn: latestDone ? (charge?.tokensIn ?? 0) : 0,
        tokensOut: latestDone ? (charge?.tokensOut ?? 0) : 0,
        usd: latestDone ? (charge?.usd ?? 0) : 0,
        cpuAvg: stat.cpuAvg,
        cpuPeak: stat.cpuPeak,
        memAvg: stat.memAvg,
        memPeak: stat.memPeak,
        killReason: stat.killReason,
        decision: verdict ? `decision: ${verdict}` : decisionLine(ownedText),
        documents: [
          ...owned.map(documentView),
          ...(log ? [{ kind: 'log', attempt: index + 1, body: log, createdAt: stat.finishedAt }] : []),
        ],
        exchanges: [],
        samples: samples
          .filter((sample) => sample.stepStatId === stat.id)
          .map((sample) => ({ at: sample.sampledAt, cpu: sample.cpuPercent, memory: sample.rssBytes })),
      };
    });
    const placeholder = raw.trim() === '' || raw.trim() === 'waiting for output' || raw.trim() === 'starting';
    const live = parentRunning && !placeholder;
    if (live) {
      visits.push({
        ...liveVisit(run.key, name, this.history.root(), visits.length, run.updatedAt, this.live?.samplesOf(run.key, name) ?? []),
        model,
        mode: 'agent',
        status: open ? 'running' : reviewerOutcome(raw, 'failed'),
        ...(charge ? { tokensIn: charge.tokensIn, tokensOut: charge.tokensOut, usd: charge.usd } : {}),
      });
    }
    return { step: name, visits, checks: [] };
  }

  /** A reviewer visit is the same record as any other step: its own log, exchange, and chart. */
  private async angleStep(run: RunEntity, name: string, documents: DocumentEntity[], stats: StepStatEntity[]) {
    const kind = `review_${name.slice('code-review-'.length)}`;
    const kinds = [kind, 'log', 'error'];
    const exchanges = await this.history.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.history.listSamples(stats.map((stat) => stat.id));
    const visits = stats.map((stat, index) => {
      const owned = documents.filter((document) => document.stepStatId === stat.id && document.kind === kind);
      const verdict = reviewDecision(owned.map((item) => item.body).join('\n'));
      return {
        id: stat.id,
        attempt: stat.attempt,
        status: verdict === 'ok' ? 'done' : verdict === 'return' ? 'waiting' : stat.status,
        model: stat.model,
        mode: stat.mode,
        durationMs: stat.durationMs,
        tokensIn: stat.tokensIn,
        tokensOut: stat.tokensOut,
        usd: stat.usd,
        cpuAvg: stat.cpuAvg,
        cpuPeak: stat.cpuPeak,
        memAvg: stat.memAvg,
        memPeak: stat.memPeak,
        killReason: stat.killReason,
        decision: verdict ? `decision: ${verdict}` : decisionLine(owned.map((item) => item.body).join('\n')),
        documents: documents
          .filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1))
          .map(documentView),
        exchanges: exchanges
          .filter((exchange) => exchange.stepStatId === stat.id)
          .map((exchange) => ({
            model: exchange.model,
            durationMs: exchange.durationMs,
            request: exchange.requestText,
            response: exchange.responseText,
          })),
        samples: samples
          .filter((sample) => sample.stepStatId === stat.id)
          .map((sample) => ({ at: sample.sampledAt, cpu: sample.cpuPercent, memory: sample.rssBytes })),
      };
    });
    const parentRunning = (run.status === 'running' || this.pipeline.claimed(run.key)) && run.currentStep === 'code-review';
    if (parentRunning && liveLogCurrent(this.history.root(), run.key, name)) {
      visits.push(
        liveVisit(run.key, name, this.history.root(), stats.at(-1)?.attempt ?? 0, run.updatedAt, this.live?.samplesOf(run.key, name) ?? []),
      );
    }
    return { step: name, visits, checks: [] };
  }

  private async rebaseWorktrees(run: RunEntity): Promise<Awaited<ReturnType<typeof rebaseFeatureRepos>>> {
    const requirements = await this.history.latestBody(run.key, 'requirements');
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const summary = summaryForBranch(requirements, run.key);
    const names = repoNames((await this.history.latestBody(run.key, 'repos')) ?? '');
    return rebaseFeatureRepos({
      root: this.history.root(),
      key: run.key,
      repos: names,
      branch: branchName(run.key, summary),
      prompt: run.prompt,
      denied: await this.history.listDenyPaths(),
      message: commitMessage(run.key, summary),
      hosts: readEnv(this.config),
    });
  }

  /** Unfinished when this run is still on implement, or no implementation notes were stored. */
  private async checklistUnfinished(run: RunEntity): Promise<boolean> {
    if (run.currentStep === 'implement') {
      return true;
    }
    const notes = (await this.history.latestBody(run.key, 'implementation')) ?? '';
    return notes.trim().length === 0;
  }

  private async startAtImplement(run: RunEntity): Promise<{ http: number; body: { key: string; status: string } }> {
    const phases = await this.history.activePhases(run.id);
    if (!phases.includes('implementation')) {
      await this.history.noteFlow(run.key, ['implementation', 'code-review', 'ci'], 'implement');
    }
    const fresh = await this.requireRun(run.key);
    fresh.currentStep = 'implement';
    fresh.status = 'waiting';
    fresh.ownerPid = null;
    fresh.stepStartedAt = null;
    await this.history.saveRun(fresh);
    return this.accepted(run.key, await this.pipeline.startDetached(run.key));
  }

  private async requireRun(key: string): Promise<RunEntity> {
    const run = await this.history.findRun(key);
    if (!run) {
      throw new NotFoundException(`${key} is missing`);
    }
    return run;
  }

  private demandStart(result: { exitCode: number; message: string }): void {
    if (result.exitCode === 0) {
      return;
    }
    if (result.message.includes('already running')) {
      throw new ConflictException(result.message);
    }
    throw new BadRequestException(result.message);
  }

  private accepted(key: string, result: { exitCode: number; message: string }): { http: number; body: { key: string; status: string } } {
    this.demandStart(result);
    if (result.message.endsWith('is done')) {
      return { http: 200, body: { key, status: 'done' } };
    }
    return { http: 202, body: { key, status: 'started' } };
  }
}

import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
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
import { isReviewStep, isStep } from '../pipeline/pipeline-result';
import { parsePaths } from '../steps/commit/commit-paths';
import { renderProjects, storedProjects } from '../steps/prepare/checkout-path';
import { reviewDecision } from '../steps/code-review/code-review-record';
import { RunSummary, FlowView, REVIEW_KINDS, STEP_KINDS } from './run-view/run-view.types';
import { angleVerdict, decisionLine, reviewerOutcome } from './run-view/chips';
import { latest, metrics, openItems, phases, reason, resumeState, returns, runName, sentence, withSkip } from './run-view/flow';
import { belongsToVisit, documentView, filesOf, withReturnNotes } from './run-view/documents';
import { launchView, liveVisit } from './run-view/live';

@Injectable()
export class RunQueriesService {
  constructor(
    private readonly history: HistoryService,
    private readonly pipeline: PipelineService,
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

  async flow(key: string): Promise<FlowView> {
    const run = await requireRun(this.history, key);
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
    const run = await requireRun(this.history, key);
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
    const run = await requireRun(this.history, key);
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

  private openSpend(run: RunEntity): LiveSpend {
    const running = run.status === 'running' || this.pipeline.claimed(run.key);
    if (!running) {
      return { tokensIn: 0, tokensOut: 0, usd: 0 };
    }
    return this.live?.spendOf(run.key) ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
  }

  private async reviewerStep(key: string, name: string) {
    const run = await requireRun(this.history, key);
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
}

export async function requireRun(history: HistoryService, key: string): Promise<RunEntity> {
  const run = await history.findRun(key);
  if (!run) {
    throw new NotFoundException(`${key} is missing`);
  }
  return run;
}

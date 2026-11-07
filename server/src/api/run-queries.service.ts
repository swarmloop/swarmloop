import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { resolveRepoRoot } from '../config/repo-root';
import { DocumentEntity, RunEntity, StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { CommandRepository } from '../history/command.repository';
import { FlowRepository } from '../history/flow.repository';
import { EventRepository } from '../history/event.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { StepEventLog } from '../history/step-event.log';
import { root } from '../history/run-paths';
import { Charge, chargeStream, modelForStep } from '../agent/spend';
import { loadPriceTable } from '../agent/prices';
import { LiveHub } from '../live/live.hub';
import { liveLogBody, liveLogCurrent } from '../agent/live-output';
import { PipelineService } from '../pipeline/pipeline.service';
import { StepRegistry } from '../steps/step.registry';
import { isStep } from '../core/pipeline-result';
import { isReviewStep } from '../contract/steps';
import { parsePaths } from '../git/commit-paths';
import { renderProjects, storedProjects } from '../steps/prepare/checkout-path';
import { reviewDecision } from '../steps/code-review/code-review-record';
import type { StepEventPage } from '../contract/step-events';
import { FlowView, HistoryView, RunsView, StepView, VisitView } from '../contract/api';
import { REVIEW_KINDS, STEP_KINDS } from './run-view/run-view.types';
import { angleVerdict, decisionLine, reviewerOutcome } from './run-view/chips';
import { latest, metrics, openItems, phases, reason, returns, runName, sentence, withSkip } from './run-view/flow';
import { belongsToVisit, documentView, filesOf, withReturnNotes } from './run-view/documents';
import { visitKey } from '../contract/visit-key';
import { launchView, liveVisit } from './run-view/live';
import { eventPaging, requireRun, runState, stepMeta } from './run-queries-run';
import { openSpend } from './run-queries-spend';
export { requireRun } from './run-queries-run';

@Injectable()
export class RunQueriesService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly flows: FlowRepository,
    private readonly commands: CommandRepository,
    private readonly events: EventRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly stepEventLog: StepEventLog,
    private readonly pipeline: PipelineService,
    private readonly registry: StepRegistry,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async list(): Promise<RunsView> {
    const runs = await this.runs.listRuns();
    const durations = await this.runs.durationByRun();
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
        usd: run.spentUsd + openSpend(run, this.pipeline, this.live).usd,
      })),
    };
  }

  async flow(key: string): Promise<FlowView> {
    const run = await requireRun(this.runs, key);
    const documents = await this.documents.listDocuments(run.id);
    const stats = await this.visits.listStats(run.id);
    const pastes = await this.checkouts.listPastes(key);
    const launches = await this.flows.listFlows(run.id);
    const open = openItems(
      run,
      documents,
      pastes.map((paste) => paste.url),
    );
    const shown = this.pipeline.claimed(run.key) && run.status !== 'done' ? { ...run, status: 'running' } : run;
    const state = await runState(this.commands, shown, open, documents);
    const maxReturns = this.config.env.MAX_RETURNS;
    const reportMs = await this.visits.codeReviewReportMs(run.id);
    return {
      key: run.key,
      name: runName(run.key, run.prompt),
      status: shown.status,
      currentStep: run.currentStep,
      updatedAt: run.updatedAt,
      stepStartedAt: run.stepStartedAt,
      ...state,
      sentence: withSkip(
        sentence(shown, open, documents, stats, maxReturns),
        shown.currentStep,
        latest(documents, 'ci_skip'),
      ),
      metrics: metrics(
        shown,
        stats,
        openSpend(shown, this.pipeline, this.live),
        this.live?.peaksOf(run.key) ?? { cpuPeak: 0, memPeak: 0 },
        reportMs,
      ),
      phases: phases(shown, stats, documents, root(this.config)),
      returns: returns(shown),
      items: open,
      paths: run.currentStep === 'commit' ? parsePaths(latest(documents, 'commit') ?? '') : [],
      reason: reason(shown, documents, stats),
      launches: launches.map(launchView),
      projects: storedProjects(
        renderProjects([...storedProjects(run.projects), ...storedProjects(latest(documents, 'pending_repos'))]),
      ),
    };
  }

  /** The events of a run, oldest first. `after` is a `seq`; `limit` is at most 500. */
  async stepEventPage(key: string, query: { step?: string; after?: string; limit?: string }): Promise<StepEventPage> {
    const run = await requireRun(this.runs, key);
    return this.stepEventLog.page(run.id, eventPaging(query));
  }

  async step(key: string, name: string): Promise<StepView> {
    if (isReviewStep(name)) {
      return this.reviewerStep(key, name);
    }
    if (!isStep(name)) {
      throw new BadRequestException(`${name} is unknown`);
    }
    const run = await requireRun(this.runs, key);
    const documents = await this.documents.listDocuments(run.id);
    const stats = (await this.visits.listStats(run.id)).filter((stat) => stat.step === name);
    const exchanges = await this.visits.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const kinds = [...(STEP_KINDS[name] ?? []), 'error', 'log'];
    const visits = stats.map((stat, index) => {
      const owned = documents.filter((document) => document.stepStatId === stat.id);
      const verdict =
        name === 'code-review'
          ? angleVerdict(
              owned
                .filter((document) => (REVIEW_KINDS as readonly string[]).includes(document.kind))
                .map((document) => document.body),
            )
          : null;
      return {
        id: stat.id,
        key: visitKey(stat.id),
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
      visits.push(
        liveVisit(run.key, name, root(this.config), stats.at(-1)?.attempt ?? 0, run.updatedAt, this.clock.now()),
      );
    }
    return {
      step: name,
      ...(await this.meta(run, name)),
      visits: withReturnNotes(name, visits, documents, this.clock.now()),
      checks:
        name === 'code-review'
          ? REVIEW_KINDS.map((kind) => {
              const body = latest(documents, kind);
              return { name: kind.replace('review_', ''), decision: decisionLine(body ?? ''), body: body ?? '' };
            }).filter((check) => check.body !== '')
          : [],
    };
  }

  async readHistory(key: string): Promise<HistoryView> {
    const run = await requireRun(this.runs, key);
    const documents = await this.documents.listDocuments(run.id);
    const stats = await this.visits.listStats(run.id);
    const exchanges = await this.visits.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const loops = await this.events.listLoops(run.id);
    const calls = await this.events.listHttpCalls(run.id);
    const launches = await this.flows.listFlows(run.id);
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
      loops: loops.map((loop) => ({
        counter: loop.counter,
        attempt: loop.attempt,
        reason: loop.reason,
        createdAt: loop.createdAt,
      })),
      calls: calls.map((call) => ({
        method: call.method,
        url: call.url,
        statusCode: call.statusCode,
        durationMs: call.durationMs,
        error: call.error,
      })),
      samples: samples.map((sample) => ({
        stepStatId: sample.stepStatId,
        at: sample.sampledAt,
        cpu: sample.cpuPercent,
        memory: sample.rssBytes,
      })),
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

  private async reviewerStep(key: string, name: string): Promise<StepView> {
    const run = await requireRun(this.runs, key);
    const documents = await this.documents.listDocuments(run.id);
    const own = (await this.visits.listStats(run.id)).filter((stat) => stat.step === name);
    if (own.length > 0) {
      return this.angleStep(run, name, documents, own);
    }
    const stats = (await this.visits.listStats(run.id)).filter((stat) => stat.step === 'code-review');
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const kind = `review_${name.slice('code-review-'.length)}`;
    const raw = liveLogBody(root(this.config), key, name);
    const env = this.config.env;
    const model = modelForStep(name, env);
    let charge: Charge | null = null;
    if (model && raw.trim() && raw !== 'waiting for output') {
      charge = chargeStream(
        model,
        raw,
        await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME, this.clock.now()),
      );
    }
    const parentRunning =
      (run.status === 'running' || this.pipeline.claimed(run.key)) && run.currentStep === 'code-review';
    const open = parentRunning && liveLogCurrent(root(this.config), key, name);
    const ownedStats = stats.filter((stat) =>
      documents.some((document) => document.stepStatId === stat.id && document.kind === kind),
    );
    const visits: VisitView[] = ownedStats.map((stat, index) => {
      const latestDone = index === ownedStats.length - 1 && !parentRunning;
      const owned = documents.filter((document) => document.stepStatId === stat.id && document.kind === kind);
      const log = latestDone ? raw : '';
      const ownedText = owned.map((item) => item.body).join('\n');
      const verdict = reviewDecision(`${ownedText}\n${log}`);
      return {
        id: stat.id,
        key: visitKey(stat.id),
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
        ...liveVisit(
          run.key,
          name,
          root(this.config),
          visits.length,
          run.updatedAt,
          this.clock.now(),
          this.live?.samplesOf(run.key, name) ?? [],
        ),
        model,
        mode: 'agent',
        status: open ? 'running' : reviewerOutcome(raw, 'failed'),
        ...(charge ? { tokensIn: charge.tokensIn, tokensOut: charge.tokensOut, usd: charge.usd } : {}),
      });
    }
    return { step: name, ...(await this.meta(run, name)), visits, checks: [] };
  }

  /** A reviewer visit is the same record as any other step: its own log, exchange, and chart. */
  private async angleStep(
    run: RunEntity,
    name: string,
    documents: DocumentEntity[],
    stats: StepStatEntity[],
  ): Promise<StepView> {
    const kind = `review_${name.slice('code-review-'.length)}`;
    const kinds = [kind, 'log', 'error'];
    const exchanges = await this.visits.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const visits = stats.map((stat, index) => {
      const owned = documents.filter((document) => document.stepStatId === stat.id && document.kind === kind);
      const verdict = reviewDecision(owned.map((item) => item.body).join('\n'));
      return {
        id: stat.id,
        key: visitKey(stat.id),
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
    const parentRunning =
      (run.status === 'running' || this.pipeline.claimed(run.key)) && run.currentStep === 'code-review';
    if (parentRunning && liveLogCurrent(root(this.config), run.key, name)) {
      visits.push(
        liveVisit(
          run.key,
          name,
          root(this.config),
          stats.at(-1)?.attempt ?? 0,
          run.updatedAt,
          this.clock.now(),
          this.live?.samplesOf(run.key, name) ?? [],
        ),
      );
    }
    return { step: name, ...(await this.meta(run, name)), visits, checks: [] };
  }

  private meta(run: RunEntity, name: string): ReturnType<typeof stepMeta> {
    return stepMeta(this.registry, this.stepEventLog, this.config.env, run, name);
  }
}

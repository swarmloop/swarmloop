import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { resolveRepoRoot } from '../config/repo-root';
import { DocumentEntity, RunEntity, StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { CommandRepository } from '../history/command.repository';
import { CheckCommandRepository } from '../history/check-command.repository';
import { FlowRepository } from '../history/flow.repository';
import { EventRepository } from '../history/event.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { StepEventLog } from '../history/step-event.log';
import { root } from '../history/run-paths';
import { agentFor } from '../config/agents';
import { Charge, chargeStream } from '../agent/spend';
import { loadPriceTable } from '../agent/prices';
import { LiveHub } from '../live/live.hub';
import { logStillOpen } from '../agent/live-output';
import { stepOutput } from '../core/attempt-output';
import { PipelineService } from '../pipeline/pipeline.service';
import { StepRegistry } from '../steps/step.registry';
import { isStep } from '../core/pipeline-result';
import { isReviewStep } from '../contract/steps';
import { parsePaths } from '../git/commit-paths';
import { renderProjects, storedProjects } from '../config/checkout-path';
import { reviewDecision } from '../steps/code-review/code-review-record';
import type { StepEventPage } from '../contract/step-events';
import { FlowView, HistoryView, RunsView, StepView, VisitView } from '../contract/api';
import type { LiveSample } from '../contract/live';
import { parentLink } from './run-view/status';
import { REVIEW_KINDS, STEP_KINDS } from './run-view/run-view.types';
import { angleVerdict, decisionLine, reviewerOutcome } from './run-view/chips';
import { latest, metrics, openItems, phases, reason, returns, runName, sentence, withSkip } from './run-view/flow';
import { belongsToVisit, documentView, filesOf, legacyLogs, taskView, withReturnNotes } from './run-view/documents';
import { visitKey } from '../contract/visit-key';
import { launchView, liveVisit } from './run-view/live';
import { commandViewsOf, exchangesOf, reviewChecks, samplesOf } from './run-view/visit-parts';
import { eventPaging, requireRun, runState, stepMeta } from './run-queries-run';
import { readCheckLog, readStepLog, visitLogSize } from './run-queries-log';
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
    private readonly checkCommands: CheckCommandRepository,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async list(): Promise<RunsView> {
    const runs = await this.runs.listRuns();
    const durations = await this.runs.durationByRun();
    const keys = new Map(runs.map((run) => [run.id, run.key]));
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
        ...parentLink(run, keys),
      })),
    };
  }

  private async parentOf(run: RunEntity): Promise<{ parentKey?: string }> {
    const parent = typeof run.parentRunId === 'number' ? await this.runs.findById(run.parentRunId) : null;
    return parent ? { parentKey: parent.key } : {};
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
      ...(await this.parentOf(run)),
      ...(run.startedBy ? { startedBy: run.startedBy } : {}),
      ...taskView(documents, run.currentStep),
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
      workspace: run.workspace === 'removed' ? 'removed' : null,
    };
  }

  /** The events of a run, oldest first. `after` is a `seq`; `limit` is at most 500. */
  async stepEventPage(key: string, query: { step?: string; after?: string; limit?: string }): Promise<StepEventPage> {
    const run = await requireRun(this.runs, key);
    return this.stepEventLog.page(run.id, eventPaging(query));
  }

  async stepLog(
    key: string,
    step: string,
    attempt: string | null,
    query: { tail?: string; from?: string; command?: string } = {},
  ): Promise<string> {
    const at = attempt || null;
    return query.command === undefined
      ? readStepLog(this.runs, this.visits, this.documents, this.config, key, step, at, query)
      : readCheckLog(this.runs, this.checkCommands, this.config, key, at, query.command, query);
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
    const kinds = [...(STEP_KINDS[name] ?? []), 'error'];
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
        ...visitLogSize(this.config, run, name, stat, documents),
        documents: [
          ...documents.filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1)),
          ...legacyLogs(documents, stat),
        ].map(documentView),
        exchanges: exchangesOf(exchanges, stat.id),
        samples: samplesOf(samples, stat.id),
      };
    });
    if (run.status === 'running' && run.currentStep === name) {
      visits.push(this.runningVisit(run, name, stats.at(-1)?.attempt ?? 0));
    }
    return {
      step: name,
      ...(await this.meta(run, name)),
      visits: withReturnNotes(name, visits, documents, this.clock.now()),
      ...(name === 'checks' ? { commands: commandViewsOf(await this.checkCommands.list(run.id)) } : {}),
      checks: name === 'code-review' ? reviewChecks(documents) : [],
    };
  }

  async readHistory(key: string): Promise<HistoryView> {
    const run = await requireRun(this.runs, key);
    const documents = await this.documents.listDocuments(run.id);
    const stats = await this.visits.listStats(run.id);
    const legacy = stats.flatMap((stat) => legacyLogs(documents, stat));
    const exchanges = await this.visits.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const loops = await this.events.listLoops(run.id);
    const calls = await this.events.listHttpCalls(run.id);
    const launches = await this.flows.listFlows(run.id);
    const reviewRunning = this.reviewRunning(run);
    return {
      launches: launches.map(launchView),
      documents: documents.filter((document) => document.kind !== 'log' || legacy.includes(document)).map(documentView),
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
        source: sample.source ?? 'agent',
      })),
      stats: stats.map((stat) => ({
        ...visitLogSize(this.config, run, stat.step, stat, documents, {
          latest: stats.filter((item) => item.step === stat.step).at(-1) === stat,
          reviewRunning,
        }),
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
    const parentRunning = this.reviewRunning(run);
    const ownedStats = stats.filter((stat) =>
      documents.some((document) => document.stepStatId === stat.id && document.kind === kind),
    );
    const attempt = parentRunning ? run.activeAttempt : (ownedStats.at(-1)?.attemptId ?? null);
    const raw = stepOutput(root(this.config), key, name, attempt);
    const env = this.config.env;
    const agent = agentFor(env, run, name);
    const model = agent?.model ?? null;
    let charge: Charge | null = null;
    if (agent && raw.trim() && raw !== 'waiting for output') {
      charge = chargeStream(
        agent.model,
        raw,
        await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), agent.runtime, this.clock.now()),
      );
    }
    const open = parentRunning && logStillOpen(raw);
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
        ...visitLogSize(this.config, run, name, stat, documents),
        documents: [...owned, ...legacyLogs(documents, stat)].map(documentView),
        exchanges: [],
        samples: samplesOf(samples, stat.id),
      };
    });
    const placeholder = raw.trim() === '' || raw.trim() === 'waiting for output' || raw.trim() === 'starting';
    const live = parentRunning && !placeholder;
    if (live) {
      visits.push({
        ...this.runningVisit(run, name, visits.length, this.live?.samplesOf(run.key, name)),
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
    const kinds = [kind, 'error'];
    const exchanges = await this.visits.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const parentRunning = this.reviewRunning(run);
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
        ...visitLogSize(this.config, run, name, stat, documents, {
          latest: index === stats.length - 1,
          reviewRunning: parentRunning,
        }),
        documents: [
          ...documents.filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1)),
          ...legacyLogs(documents, stat),
        ].map(documentView),
        exchanges: exchangesOf(exchanges, stat.id),
        samples: samplesOf(samples, stat.id),
      };
    });
    if (parentRunning && logStillOpen(stepOutput(root(this.config), run.key, name, run.activeAttempt))) {
      visits.push(this.runningVisit(run, name, stats.at(-1)?.attempt ?? 0, this.live?.samplesOf(run.key, name)));
    }
    return { step: name, ...(await this.meta(run, name)), visits, checks: [] };
  }

  /** True while the code-review step runs, so its reviewers write the run's active attempt. */
  private reviewRunning(run: RunEntity): boolean {
    return (run.status === 'running' || this.pipeline.claimed(run.key)) && run.currentStep === 'code-review';
  }

  private runningVisit(run: RunEntity, name: string, previousAttempt: number, samples?: LiveSample[]): VisitView {
    const now = this.clock.now();
    return liveVisit(run.key, name, root(this.config), run.activeAttempt, previousAttempt, run.updatedAt, now, samples);
  }

  private meta(run: RunEntity, name: string): ReturnType<typeof stepMeta> {
    return stepMeta(this.registry, this.stepEventLog, this.config.env, run, name);
  }
}

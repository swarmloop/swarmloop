import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { RunEntity } from '../history/entities';
import { BacklogRepository } from '../history/backlog.repository';
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
import { LiveHub } from '../live/live.hub';
import { ContainerGate } from '../sandbox/container-gate';
import { PipelineService } from '../pipeline/pipeline.service';
import { StepRegistry } from '../steps/step.registry';
import { isStep } from '../core/pipeline-result';
import { isReviewStep } from '../contract/steps';
import { parsePaths } from '../git/commit-paths';
import { renderProjects, storedProjects } from '../config/checkout-path';
import type { StepEventPage } from '../contract/step-events';
import { FlowView, HistoryView, StepView, VisitView } from '../contract/api';
import type { LiveSample } from '../contract/live';
import { runPlace, withPlaceChips } from './run-view/agent-place';
import { withRestartWait } from './run-view/restart-wait';
import { parentOf } from './run-view/merge-wait';
import { epicTotal } from '../steps/shared/epic-total';
import { STEP_KINDS } from './run-view/run-view.types';
import { angleVerdict, decisionLine, decisionStatus } from './run-view/chips';
import { latest, metrics, phases, returns, runName } from './run-view/flow';
import { reason, sentence, withSkip } from './run-view/flow-waiting';
import { belongsToVisit, documentView, interruptionOf, taskView, withReturnNotes } from './run-view/documents';
import { mergeRequestViews } from './run-view/merge-requests';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { taskRuns } from './run-view/task-runs';
import { ReviewerSteps } from './run-view/reviewer-steps';
import { visitKey } from '../contract/visit-key';
import { launchView, liveVisit } from './run-view/live';
import {
  commandViewsOf,
  effortOf,
  exchangesOf,
  latestCommandViews,
  reviewChecks,
  samplesOf,
} from './run-view/visit-parts';
import { eventPaging, requireRun, runState, stepMeta } from './run-queries-run';
import { outputsOf, readCheckLog, readStepLog, visitLogSize } from './run-queries-log';
import { openItems } from '../steps/shared/open-items';
import { viewTitle } from './run-view/run-title';
import type { Part, RunsPage } from '../contract/run-list';
import { RunListRows } from './run-list-rows';
import { pageOf } from './run-list-page';
import { readHistory } from './run-queries-history';
import { openSpend, spentUsd } from './run-queries-spend';
import { parseSubtasks, SUBTASKS_KIND } from '../contract/subtask';
import { conversationView } from './run-view/conversation';
import { readPlanChat } from '../contract/plan-chat';
import { PlannerTurns } from '../pipeline/planner-turns';
import { RunReport } from '../steps/shared/run-report';
import { OpenReviewRounds } from '../steps/shared/open-review-rounds';
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
    private readonly runReport: RunReport,
    private readonly backlogs: BacklogRepository,
    private readonly rows: RunListRows,
    @Optional() private readonly live?: LiveHub,
    @Optional() private readonly gate: ContainerGate = new ContainerGate(),
    @Optional() private readonly turns?: PlannerTurns,
    @Optional() private readonly openRounds?: OpenReviewRounds,
  ) {
    this.reviewers = new ReviewerSteps({
      runs,
      documents,
      visits,
      config,
      clock,
      live,
      reviewRunning: (run) => this.reviewRunning(run),
      runningVisit: (run, name, previousAttempt, samples) => this.runningVisit(run, name, previousAttempt, samples),
      meta: (run, name) => this.meta(run, name),
    });
  }

  private readonly reviewers: ReviewerSteps;

  async list(query: { part: Part; q: string; cursor?: string } = { part: 'active', q: '' }): Promise<RunsPage> {
    return pageOf((await this.rows.read()).view.runs, query);
  }

  private readonly usdOf = (run: RunEntity): number => spentUsd(run, this.pipeline, this.live);

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
    const state = await runState(this.commands, shown, open, documents, runPlace(this.gate.agentWait(run.key)));
    const maxReturns = this.config.env.MAX_RETURNS;
    const reportMs = await this.visits.codeReviewReportMs(run.id);
    const children = await this.runs.children(run);
    const loops = await this.events.listLoops(run.id);
    const checkCommands = latestCommandViews(await this.checkCommands.list(run.id));
    const label = (await this.backlogs.labelsFor([run.key])).get(run.key);
    const parent = await parentOf(this.runs, this.documents, run);
    return {
      key: run.key,
      name: runName(run.key, run.prompt),
      title: viewTitle(run, latest(documents, 'requirements')),
      mergeRequests: mergeRequestViews(
        run.mergeOutcome,
        latest(documents, ARTIFACTS.mergeRequest.kind),
        latest(documents, ARTIFACTS.repos.kind),
      ),
      status: shown.status,
      currentStep: run.currentStep,
      updatedAt: run.updatedAt,
      stepStartedAt: run.stepStartedAt,
      ...parent,
      ...(label ? { backlog: label } : {}),
      ...(run.startedBy ? { startedBy: run.startedBy } : {}),
      ...(run.ownerSince ? { ownerSince: run.ownerSince } : {}),
      ...taskView(
        documents,
        run.currentStep,
        await taskRuns(
          this.runs,
          this.visits,
          children,
          documents,
          this.pipeline,
          { documents: this.documents, checkouts: this.checkouts, commands: this.commands },
          this.live,
          (key) => runPlace(this.gate.agentWait(key)),
        ),
      ),
      ...epicTotal(shown, children, this.usdOf, this.clock.now()),
      ...state,
      conversation: conversationView({
        run,
        split: parseSubtasks(latest(documents, SUBTASKS_KIND)).length > 0,
        state: state.state,
        parentKey: parent.parentKey,
        items: open,
        log: readPlanChat(latest(documents, ARTIFACTS.planChat.kind)),
        replying: this.turns?.replying(run.key) ?? false,
      }),
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
      phases: withRestartWait(
        withPlaceChips(
          phases(shown, stats, documents, root(this.config), loops, this.openRounds?.of(run.key)),
          this.gate.agentWait(run.key),
        ),
        run,
      ),
      returns: returns(shown, loops),
      ...(checkCommands.length > 0 ? { checkCommands } : {}),
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
      ? readStepLog(this.runs, this.visits, this.config, key, step, at, query)
      : readCheckLog(this.runs, this.checkCommands, this.config, key, at, query.command, query);
  }

  async step(key: string, name: string): Promise<StepView> {
    if (isReviewStep(name)) {
      return this.reviewers.step(key, name);
    }
    if (!isStep(name)) {
      throw new BadRequestException(`${name} is unknown`);
    }
    const run = await requireRun(this.runs, key);
    const documents = await this.documents.listDocuments(run.id);
    const runStats = await this.visits.listStats(run.id);
    const stats = runStats.filter((stat) => stat.step === name);
    const exchanges = await this.visits.listExchanges(stats.map((stat) => stat.id));
    const samples = await this.visits.listSamples(stats.map((stat) => stat.id));
    const kinds = [...(STEP_KINDS[name] ?? []), 'error'];
    const outputs = await outputsOf(this.config, run, runStats, false);
    const visits: VisitView[] = stats.map((stat, index) => {
      const owned = documents.filter((document) => document.stepStatId === stat.id);
      const verdict = name === 'code-review' ? angleVerdict(owned) : null;
      const interruption = interruptionOf(owned, stat.id);
      return {
        id: stat.id,
        key: visitKey(stat.id),
        attempt: stat.attempt,
        status: decisionStatus(verdict, stat.status),
        model: stat.model,
        ...effortOf(stat),
        mode: stat.mode,
        durationMs: stat.durationMs,
        preparedMs: stat.preparedMs,
        tokensIn: stat.tokensIn,
        tokensOut: stat.tokensOut,
        usd: stat.usd,
        cpuAvg: stat.cpuAvg,
        cpuPeak: stat.cpuPeak,
        memAvg: stat.memAvg,
        memPeak: stat.memPeak,
        killReason: stat.killReason,
        ...(interruption ? { interruption } : {}),
        decision: verdict ? `decision: ${verdict}` : decisionLine(owned.map((document) => document.body).join('\n')),
        ...visitLogSize(outputs, run, name, stat),
        documents: documents
          .filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1))
          .map(documentView),
        exchanges: exchangesOf(exchanges, stat.id),
        samples: samplesOf(samples, stat.id),
      };
    });
    if (run.status === 'running' && run.currentStep === name) {
      visits.push(this.runningVisit(run, name, stats.at(-1)?.attempt ?? 0));
    }
    const report = name === 'code-review' ? await this.runReport.render(run) : null;
    return {
      step: name,
      ...(await this.meta(run, name)),
      visits: withReturnNotes(name, visits, documents, this.clock.now()),
      ...(name === 'checks' ? { commands: commandViewsOf(await this.checkCommands.list(run.id)) } : {}),
      checks: name === 'code-review' ? reviewChecks(documents) : [],
      ...(report ? { report } : {}),
    };
  }

  async readHistory(key: string): Promise<HistoryView> {
    return readHistory(
      {
        runs: this.runs,
        documents: this.documents,
        visits: this.visits,
        events: this.events,
        flows: this.flows,
        config: this.config,
      },
      key,
      (run) => this.reviewRunning(run),
    );
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

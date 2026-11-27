import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunRebase } from '../run-rebase';
import { RunStop } from '../../agent/run-stop';
import { ciFileProjects, missingPipeline, missingRuns } from './missing-pipeline';
import { backToReview, staleGates } from './stale-gates';
import { type SwarmloopEnv } from '../../config/env';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { FlakyTestRepository } from '../../history/flaky-test.repository';
import { EventRepository } from '../../history/event.repository';
import { root } from '../../history/run-paths';
import { delay } from '../../core/delay';
import { AwakeTime } from '../../core/awake-time';
import type { StepName } from '../../contract/steps';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { SwarmloopError } from '../../core/swarmloop-error';
import { assertNotStopped } from '../../agent/step-stopped';
import { BaseStep, type StepContext } from '../base-step';
import {
  ciResult,
  classify,
  ciTitle,
  jobResults,
  parsePipelineRefs,
  renderNone,
  renderPass,
  stopLine,
  isRunning,
  pendingNote,
  runRows,
  unstartedRuns,
  checkFacts,
  verdictOf,
  type Verdict,
  type InfraCode,
  type Seen,
} from './pipeline-report';
import { finishedRuns, rerunJobs } from './ci-host';
import { ARTIFACTS } from '../contract/artifacts';
import { mergeRequestDetails, parseMergeRequests } from '../merge-request/merge-request-record';
import { cancelRunning } from './cancel-running';
import { loadSeen } from './load-seen';
import { atBranchHeads } from './branch-heads';
import { flakyOnPass } from './flaky-tests';
import { finish } from './pipeline-result';
import { infraBlockedEnd } from './pipeline-infra-end';
import { watchCi } from './pipeline-watch';
import { dropNoCi, noCiLines, noCiReason, type CiScope, type NoCiProject } from './pipeline-no-ci';
import { hasDraft, markReady } from './pipeline-draft';
import { red, report, type RedDeps } from './pipeline-red';
import { EnvironmentService } from '../../environment/environment.service';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

/** `repos` is read only when a green or absent pipeline asks whether CI started, so it is loaded there. */
const INPUTS = {
  pipelineRef: { artifact: ARTIFACTS.pipelineRef, need: 'start' },
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional' },
  repos: { artifact: ARTIFACTS.repos, need: 'optional', late: true },
  mergeRequest: { artifact: ARTIFACTS.mergeRequest, need: 'optional', late: true },
} as const satisfies InputSpec;

/** The pauses before the two automatic re-runs of a run whose jobs never ran. */
const RERUN_PAUSES_MS = [60_000, 300_000];

@Injectable()
export class PipelineStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'pipeline';
  readonly inputs = INPUTS;
  readonly outputs = [
    ARTIFACTS.pipelineLog,
    ARTIFACTS.return,
    ARTIFACTS.issues,
    ARTIFACTS.pipelineRebases,
    ARTIFACTS.ciWaits,
    ARTIFACTS.flaky,
    ARTIFACTS.mergeRequest,
  ];

  constructor(
    kernel: StepKernel,
    private readonly events: EventRepository,
    private readonly registry: CodeHostRegistry,
    private readonly rebase: RunRebase,
    private readonly runStop: RunStop,
    private readonly environments: EnvironmentService,
    private readonly flaky: FlakyTestRepository,
  ) {
    super(kernel);
  }

  private get redDeps(): RedDeps {
    return {
      environments: this.environments,
      events: this.events,
      visits: this.kernel.visits,
      config: this.config,
      flaky: this.flaky,
      defaultBranch: {
        runs: this.runs,
        rebase: this.rebase,
        halted: (key) => this.runStop.halted(key),
        hosts: async (run) => ({
          ...this.config.env,
          ...(await this.registry.tokensFor(run.startedBy, run.codeHost)),
          clock: this.clock,
        }),
        root: root(this.config),
      },
    };
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { opened } = ctx;
    const env = this.config.env;
    const recorded = parsePipelineRefs(input.pipelineRef ?? '');
    const skipped = input.ciSkip?.trim() ?? '';
    if (recorded.length === 0 && skipped) {
      return finish('ok', report(opened, skipped), 'skipped', skipped);
    }
    const host = await this.registry.hostFor(opened.run);
    if (recorded.length === 0) {
      throw new SwarmloopError('pipeline ref is missing');
    }
    const records = await atBranchHeads(host, recorded, ctx.calls);
    const waited = await ctx.activity(
      ciTitle(records),
      () => this.firstLookAndWait(ctx, env, records, host),
      (value) => (value.watched ? ciResult(value.watched) : 'no CI to wait for'),
    );
    const { scope, watched } = waited;
    if (!watched) {
      return this.withFacts(ctx, await this.endWithoutCi(ctx, scope.dropped), []);
    }
    return this.withFacts(ctx, await this.route(ctx, env, scope, watched.seen, watched.verdict, host), watched.seen);
  }

  /** Decides which projects have CI on the first look, and waits for the ones that do. */
  private async firstLookAndWait(
    ctx: StepContext,
    env: SwarmloopEnv,
    records: PipelineRef[],
    host: CodeHost,
  ): Promise<{ scope: CiScope; watched: { seen: Seen[]; verdict: Verdict } | null }> {
    const scope = await this.scopeOf(ctx, records, host);
    if (scope.records.length === 0) {
      return { scope, watched: null };
    }
    return { scope, watched: await this.watch(ctx, scope.records, env, host, scope.seen) };
  }

  /** The first look at the CI of every ref, before any wait: the projects with no CI are left out of it. */
  private async scopeOf(ctx: StepContext, records: PipelineRef[], host: CodeHost): Promise<CiScope> {
    assertNotStopped(this.runStop, ctx.opened.run.key);
    const seen = await loadSeen(records, ctx.calls, host, false);
    const showedNothing = seen.some((item) => item.runs.length === 0 && item.checks.length === 0);
    const ciFiles = showedNothing ? await ciFileProjects(ctx, root(this.config)) : new Set<string>();
    return dropNoCi(host, records, seen, ctx.calls, ciFiles);
  }

  private async withFacts(ctx: StepContext, result: StepResult, seen: Seen[]): Promise<StepResult> {
    const requests = await ctx.reread(ARTIFACTS.mergeRequest);
    const links = requests ? mergeRequestDetails(parseMergeRequests(requests)) : [];
    return { ...result, facts: { details: [...jobResults(seen), ...links], ...checkFacts(seen) } };
  }

  private watch(
    ctx: StepContext,
    records: PipelineRef[],
    env: SwarmloopEnv,
    host: CodeHost,
    firstLook?: Seen[],
  ): Promise<{ seen: Seen[]; verdict: Verdict }> {
    return watchCi(
      ctx,
      records,
      env,
      host,
      { awake: this.awakeTime(env), runStop: this.runStop, root: root(this.config) },
      firstLook,
    );
  }

  /** Awake time of one wait: the host sleeping between two polls does not count. */
  private awakeTime(env: SwarmloopEnv): AwakeTime {
    return new AwakeTime(this.clock, env.TICK_MS);
  }

  private async route(
    ctx: StepContext,
    env: SwarmloopEnv,
    scope: CiScope,
    seen: Seen[],
    verdict: Verdict,
    host: CodeHost,
    reruns = 0,
  ): Promise<StepResult> {
    const { opened, calls } = ctx;
    if (verdict === 'unstarted') {
      return this.infra(ctx, env, scope, seen, 'CI_NOT_RUN', host, reruns);
    }
    if (verdict === 'wait' && runRows(seen, isRunning).length === 0) {
      return this.stalled(ctx, env, scope, seen, host, reruns);
    }
    if (verdict === 'wait') {
      const settled = await cancelRunning({
        seen,
        calls,
        env,
        host,
        load: (jobs) => loadSeen(scope.records, calls, host, jobs),
        awakeTime: () => this.awakeTime(env),
      });
      if (!settled.traces) {
        return red(this.redDeps, ctx, env, settled.seen, host, settled.note, false);
      }
      const next = verdictOf(settled.seen);
      if (next === 'red' || next === 'wait') {
        return red(this.redDeps, ctx, env, settled.seen, host, settled.note, true);
      }
      seen = settled.seen;
      verdict = next;
    }
    if (verdict === 'red') {
      const cause = classify(seen);
      return cause === 'failed'
        ? red(this.redDeps, ctx, env, seen, host)
        : this.infra(ctx, env, scope, seen, cause === 'timeout' ? 'CI_TIMEOUT' : 'CI_NOT_RUN', host, reruns);
    }
    if (verdict === 'stop') {
      return finish('failed', report(opened, stopLine(seen)), 'failed');
    }
    if (verdict === 'manual') {
      return finish('waiting', report(opened, 'pipeline is manual'), 'waiting');
    }
    return this.settle(ctx, env, scope, seen, host, reruns);
  }

  /**
   * The wait ended with a green or absent verdict. A project whose workflow never ran is a missing pipeline. For the
   * rest: stale gates, an absent draft or the pass. The projects left out at the start are named in the log.
   */
  private async settle(
    ctx: StepContext,
    env: SwarmloopEnv,
    scope: CiScope,
    seen: Seen[],
    host: CodeHost,
    reruns: number,
  ): Promise<StepResult> {
    const { opened } = ctx;
    const { records, dropped } = scope;
    const missing = await missingRuns(ctx, root(this.config), seen);
    if (missing && missing.length > 0) {
      return missingPipeline({
        ctx,
        runs: this.runs,
        events: this.events,
        rebase: this.rebase,
        halted: () => this.runStop.halted(opened.run.key),
        root: root(this.config),
        limit: env.MAX_PIPELINE_RETURNS,
        host,
        records,
        seen,
        missing,
      });
    }
    const verdict = verdictOf(seen);
    const noCiLog = noCiLines(dropped);
    if (await staleGates(ctx, root(this.config), await this.flows.activePhases(opened.run.id))) {
      return backToReview(ctx, this.flows);
    }
    if (verdict === 'absent') {
      if (await hasDraft(ctx)) {
        await ctx.activity(
          'Mark merge request ready',
          () => markReady(ctx, this.registry),
          () => 'CI did not start for the draft',
        );
        const watched = await this.watch(ctx, records, env, host);
        return this.route(ctx, env, scope, watched.seen, watched.verdict, host, reruns);
      }
      const body = `${renderNone(seen)}${noCiLog}`;
      return finish('ok', report(opened, 'nothing started', body), 'done', body);
    }
    const warnings = seen.flatMap((item) =>
      item.jobs
        .filter((job) => job.status === 'failed' && job.allowFailure)
        .map((job) => `${item.project} ${job.name}`),
    );
    const deps = { documents: this.kernel.documents, flaky: this.flaky, root: root(this.config) };
    const flaky = await flakyOnPass(deps, ctx, records, seen, host);
    if (flaky) {
      return flaky;
    }
    const body = `${renderPass(seen, warnings)}${noCiLog}`;
    await markReady(ctx, this.registry);
    return finish('ok', report(opened, 'pipeline done', body), 'done', body);
  }

  /** No project has CI: the checks and the reviewers are the gate, so the run ends skipped with its merge requests ready. */
  private async endWithoutCi(ctx: StepContext, dropped: NoCiProject[]): Promise<StepResult> {
    if (await staleGates(ctx, root(this.config), await this.flows.activePhases(ctx.opened.run.id))) {
      return backToReview(ctx, this.flows);
    }
    await markReady(ctx, this.registry);
    const reason = noCiReason(dropped);
    return finish('ok', report(ctx.opened, reason), 'skipped', reason);
  }

  /** The wait ended with no run left to cancel: a check that never showed up is dropped, one that never ended is red. */
  private async stalled(
    ctx: StepContext,
    env: SwarmloopEnv,
    scope: CiScope,
    seen: Seen[],
    host: CodeHost,
    reruns: number,
  ): Promise<StepResult> {
    const note = pendingNote(seen, Math.round(env.PIPELINE_TIMEOUT_MS / 60000));
    if (note) {
      return red(this.redDeps, ctx, env, seen, host, note, true);
    }
    const settled = seen.map((item) => ({ ...item, awaiting: [] }));
    return this.route(ctx, env, scope, settled, verdictOf(settled), host, reruns);
  }

  /**
   * A finished run with no failed job: the cause is on the CI side, so nothing goes to an agent.
   * Its jobs are re-run after each pause of RERUN_PAUSES_MS, then the run is routed again; when the last one ends the same way the run blocks.
   */
  private async infra(
    ctx: StepContext,
    env: SwarmloopEnv,
    scope: CiScope,
    seen: Seen[],
    code: InfraCode,
    host: CodeHost,
    reruns: number,
  ): Promise<StepResult> {
    const { opened, calls } = ctx;
    const finished = finishedRuns(seen);
    const unstarted = unstartedRuns(seen);
    const pause = unstarted.length > 0 ? undefined : RERUN_PAUSES_MS[reruns];
    const errors: string[] = [];
    if (pause !== undefined) {
      await delay(pause);
      assertNotStopped(this.runStop, opened.run.key);
      errors.push(...(await rerunJobs(host, finished, calls)));
      if (errors.length === 0) {
        const watched = await this.watch(ctx, scope.records, env, host);
        return this.route(ctx, env, scope, watched.seen, watched.verdict, host, reruns + 1);
      }
    }
    return infraBlockedEnd({
      opened,
      calls,
      host,
      code,
      seen,
      unstarted,
      finished,
      reruns,
      errors,
      startTimeoutMs: env.PIPELINE_START_TIMEOUT_MS,
    });
  }
}

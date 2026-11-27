import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunRebase } from '../run-rebase';
import { RunStop } from '../../agent/run-stop';
import { missingPipeline, missingRuns } from './missing-pipeline';
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
import { CI_INFRA_SOURCE, issueOf } from '../shared/handoff';
import { assertNotStopped } from '../../agent/step-stopped';
import { BaseStep, type StepContext } from '../base-step';
import {
  ciResult,
  classify,
  ciTitle,
  jobResults,
  parsePipelineRefs,
  renderInfra,
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
import { finishedRuns, readNotes, rerunJobs } from './ci-host';
import { ARTIFACTS } from '../contract/artifacts';
import { mergeRequestDetails, parseMergeRequests } from '../merge-request/merge-request-record';
import { cancelRunning } from './cancel-running';
import { loadSeen } from './load-seen';
import { atBranchHeads } from './branch-heads';
import { flakyOnPass } from './flaky-tests';
import { blockedEnd, finish } from './pipeline-result';
import { watchCi } from './pipeline-watch';
import { dropNoCi, leaveOut, noCiLines, noCiReason, type NoCiProject } from './pipeline-no-ci';
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

/** What was tried before a person is asked: the wait for a run that never started, or the reruns that ended the same way. */
function triedLine(unstarted: boolean, reruns: number, notes: string, startTimeoutMs: number): string {
  if (unstarted) {
    const minutes = Math.round(startTimeoutMs / 60000);
    return `tried: waited ${minutes} minutes for the host to start the run${notes ? `; the host says: ${notes}` : ''}\n`;
  }
  return reruns > 0 ? `tried: ${reruns} reruns of the failed jobs\n` : '';
}

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
    const watched = await ctx.activity(ciTitle(records), () => this.watch(ctx, records, env, host), ciResult);
    const result = await this.route(ctx, env, records, watched.seen, watched.verdict, host);
    const requests = await ctx.reread(ARTIFACTS.mergeRequest);
    const links = requests ? mergeRequestDetails(parseMergeRequests(requests)) : [];
    return { ...result, facts: { details: [...jobResults(watched.seen), ...links], ...checkFacts(watched.seen) } };
  }

  private watch(
    ctx: StepContext,
    records: PipelineRef[],
    env: SwarmloopEnv,
    host: CodeHost,
  ): Promise<{ seen: Seen[]; verdict: Verdict }> {
    return watchCi(ctx, records, env, host, {
      awake: this.awakeTime(env),
      runStop: this.runStop,
      root: root(this.config),
    });
  }

  /** Awake time of one wait: the host sleeping between two polls does not count. */
  private awakeTime(env: SwarmloopEnv): AwakeTime {
    return new AwakeTime(this.clock, env.TICK_MS);
  }

  private async route(
    ctx: StepContext,
    env: SwarmloopEnv,
    records: PipelineRef[],
    seen: Seen[],
    verdict: Verdict,
    host: CodeHost,
    reruns = 0,
  ): Promise<StepResult> {
    const { opened, calls } = ctx;
    if (verdict === 'unstarted') {
      return this.infra(ctx, env, records, seen, 'CI_NOT_RUN', host, reruns);
    }
    if (verdict === 'wait' && runRows(seen, isRunning).length === 0) {
      return this.stalled(ctx, env, records, seen, host, reruns);
    }
    if (verdict === 'wait') {
      const settled = await cancelRunning({
        seen,
        calls,
        env,
        host,
        load: (jobs) => loadSeen(records, calls, host, jobs),
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
        : this.infra(ctx, env, records, seen, cause === 'timeout' ? 'CI_TIMEOUT' : 'CI_NOT_RUN', host, reruns);
    }
    if (verdict === 'stop') {
      return finish('failed', report(opened, stopLine(seen)), 'failed');
    }
    if (verdict === 'manual') {
      return finish('waiting', report(opened, 'pipeline is manual'), 'waiting');
    }
    return this.settle(ctx, env, records, seen, host, reruns);
  }

  /**
   * The wait ended with a green or absent verdict. A project whose host refuses to read its pipelines can never show a
   * run, so it is not waited for whatever its tree holds. A project whose workflow never ran is a missing pipeline.
   * A project with no CI is left out, and when none is left the run ends skipped. For the rest: stale gates, an absent
   * draft or the pass.
   */
  private async settle(
    ctx: StepContext,
    env: SwarmloopEnv,
    refs: PipelineRef[],
    read: Seen[],
    host: CodeHost,
    reruns: number,
  ): Promise<StepResult> {
    const { opened } = ctx;
    const gate = await dropNoCi(host, refs, read, ctx.calls);
    const { dropped } = gate;
    const readable = leaveOut(
      dropped.filter((item) => item.refused),
      refs,
      read,
    );
    const missing = await missingRuns(ctx, root(this.config), readable.seen);
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
        records: readable.records,
        seen: readable.seen,
        missing,
      });
    }
    const { records, seen } = gate;
    if (records.length === 0) {
      return this.endWithoutCi(ctx, env, refs, host, reruns, dropped);
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
        return this.route(ctx, env, records, watched.seen, watched.verdict, host, reruns);
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
  private async endWithoutCi(
    ctx: StepContext,
    env: SwarmloopEnv,
    records: PipelineRef[],
    host: CodeHost,
    reruns: number,
    dropped: NoCiProject[],
  ): Promise<StepResult> {
    if (await hasDraft(ctx)) {
      await ctx.activity(
        'Mark merge request ready',
        () => markReady(ctx, this.registry),
        () => 'CI did not start for the draft',
      );
      const watched = await this.watch(ctx, records, env, host);
      return this.route(ctx, env, records, watched.seen, watched.verdict, host, reruns);
    }
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
    records: PipelineRef[],
    seen: Seen[],
    host: CodeHost,
    reruns: number,
  ): Promise<StepResult> {
    const note = pendingNote(seen, Math.round(env.PIPELINE_TIMEOUT_MS / 60000));
    if (note) {
      return red(this.redDeps, ctx, env, seen, host, note, true);
    }
    const settled = seen.map((item) => ({ ...item, awaiting: [] }));
    return this.route(ctx, env, records, settled, verdictOf(settled), host, reruns);
  }

  /**
   * A finished run with no failed job: the cause is on the CI side, so nothing goes to an agent.
   * Its jobs are re-run after each pause of RERUN_PAUSES_MS, then the run is routed again; when the last one ends the same way the run blocks.
   */
  private async infra(
    ctx: StepContext,
    env: SwarmloopEnv,
    records: PipelineRef[],
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
        const watched = await this.watch(ctx, records, env, host);
        return this.route(ctx, env, records, watched.seen, watched.verdict, host, reruns + 1);
      }
    }
    const notes = await readNotes(host, unstarted.length > 0 ? unstarted : finished, calls);
    const tried = triedLine(unstarted.length > 0, reruns, notes, env.PIPELINE_START_TIMEOUT_MS);
    const body = `${renderInfra(code, seen, notes)}${tried}${errors.map((error) => `rerun: ${error}\n`).join('')}`;
    const result = blockedEnd(
      report(opened, code === 'CI_TIMEOUT' ? 'CI timed out' : 'CI did not run', body),
      code,
      body,
    );
    const issue = issueOf(CI_INFRA_SOURCE, code, body);
    return { ...result, outputs: [...result.outputs, { artifact: ARTIFACTS.issues, value: [issue] }] };
  }
}

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
import { recordStepEvent } from '../../core/step-event-scope';
import type { StepName } from '../../contract/steps';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
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
  externalWork,
  pendingNote,
  runRows,
  unstartedRuns,
  waitingFor,
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
import { flakyOnPass } from './flaky-tests';
import { finish } from './pipeline-result';
import { stuckAtStart } from './stuck-start';
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
    const records = parsePipelineRefs(input.pipelineRef ?? '');
    const skipped = input.ciSkip?.trim() ?? '';
    if (records.length === 0 && skipped) {
      return finish('ok', report(opened, skipped), 'skipped', skipped);
    }
    const host = await this.registry.hostFor(opened.run);
    if (records.length === 0) {
      throw new SwarmloopError('pipeline ref is missing');
    }
    const watched = await ctx.activity(ciTitle(records), () => this.watch(ctx, records, env, host), ciResult);
    const result = await this.route(ctx, env, records, watched.seen, watched.verdict, host);
    const requests = await ctx.reread(ARTIFACTS.mergeRequest);
    const links = requests ? mergeRequestDetails(parseMergeRequests(requests)) : [];
    return { ...result, facts: { details: [...jobResults(watched.seen), ...links], ...checkFacts(watched.seen) } };
  }

  private async watch(
    ctx: StepContext,
    records: PipelineRef[],
    env: SwarmloopEnv,
    host: CodeHost,
  ): Promise<{ seen: Seen[]; verdict: Verdict }> {
    const { calls } = ctx;
    const awake = this.awakeTime(env);
    assertNotStopped(this.runStop, ctx.opened.run.key);
    let seen = await awake.run(() => this.load(records, calls, host, false));
    let verdict = verdictOf(seen);
    let said: string | null = null;
    const unstartedSince = new Map<number, number>();
    stuckAtStart(unstartedSince, seen, awake.elapsedMs(), env.PIPELINE_START_TIMEOUT_MS);
    while (
      awake.elapsedMs() < env.PIPELINE_TIMEOUT_MS &&
      (verdict === 'wait' || verdict === 'absent' || verdict === 'green')
    ) {
      const missing = verdict === 'wait' ? null : await awake.run(() => missingRuns(ctx, root(this.config), seen));
      if (verdict === 'green' && !(missing && missing.length > 0)) {
        break;
      }
      if (verdict === 'absent' && missing?.length === 0) {
        break;
      }
      const limit = verdict === 'wait' ? env.PIPELINE_TIMEOUT_MS : env.PIPELINE_START_TIMEOUT_MS;
      const pause = Math.min(env.TICK_MS, limit - awake.elapsedMs());
      if (pause <= 0) {
        break;
      }
      await delay(pause);
      assertNotStopped(this.runStop, ctx.opened.run.key, externalWork(seen));
      seen = await awake.run(() => this.load(records, calls, host));
      verdict = verdictOf(seen);
      const waiting = verdict === 'wait' ? waitingFor(seen) : null;
      if (waiting && waiting !== said) {
        await ctx.activity(waiting, () => Promise.resolve());
      }
      said = waiting ?? said;
      if (stuckAtStart(unstartedSince, seen, awake.elapsedMs(), env.PIPELINE_START_TIMEOUT_MS)) {
        return { seen, verdict: 'unstarted' };
      }
    }
    return { seen, verdict };
  }

  /** Awake time of one wait: the host sleeping between two polls does not count. */
  private awakeTime(env: SwarmloopEnv): AwakeTime {
    return new AwakeTime(this.clock, env.TICK_MS, (ms) => recordStepEvent({ kind: 'host.suspended', durationMs: ms }));
  }

  private async load(records: PipelineRef[], calls: HttpCallDraft[], host: CodeHost, jobs = true): Promise<Seen[]> {
    const loaded = await Promise.all(
      records.map(async (record) => {
        const result = await host.readBranchPipeline(record, jobs);
        return {
          result,
          seen: {
            project: record.project,
            id: result.snapshot?.id ?? null,
            sha: record.sha ?? '',
            url: result.snapshot?.url ?? '',
            status: result.snapshot?.status ?? 'none',
            jobs: result.snapshot?.jobs ?? [],
            runs: result.snapshot?.runs ?? [],
            checks: result.snapshot?.checks ?? [],
            awaiting: result.snapshot?.awaiting ?? [],
          },
        };
      }),
    );
    for (const item of loaded) {
      calls.push(...item.result.httpCalls);
    }
    return loaded.map((item) => item.seen);
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
        load: (jobs) => this.load(records, calls, host, jobs),
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
      const body = renderNone(seen);
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
    const body = renderPass(seen, warnings);
    await markReady(ctx, this.registry);
    return finish('ok', report(opened, 'pipeline done', body), 'done', body);
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
    const result = finish(
      'blocked',
      report(opened, code === 'CI_TIMEOUT' ? 'CI timed out' : 'CI did not run', body),
      'blocked',
      body,
    );
    const issue = issueOf(CI_INFRA_SOURCE, code, body);
    return { ...result, outputs: [...result.outputs, { artifact: ARTIFACTS.issues, value: [issue] }] };
  }
}

import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunRebase } from '../run-rebase';
import { RunStop } from '../../agent/run-stop';
import { missingPipeline, missingRuns } from './missing-pipeline';
import { backToReview, staleGates } from './stale-gates';
import { type SwarmloopEnv } from '../../config/env';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { EventRepository } from '../../history/event.repository';
import { root } from '../../history/run-paths';
import { delay } from '../../core/delay';
import { AwakeTime } from '../../core/awake-time';
import { recordStepEvent } from '../../core/step-event-scope';
import type { StepName } from '../../contract/steps';
import type { OpenedStep } from '../../steps/step-run';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { FetchFailed, SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { CI_INFRA_SOURCE, issueOf } from '../shared/handoff';
import { assertNotStopped } from '../shared/step-stopped';
import { BaseStep, type StepContext } from '../base-step';
import {
  cancelErrorNote,
  ciResult,
  classify,
  ciTitle,
  jobResults,
  parsePipelineRefs,
  renderFail,
  renderInfra,
  renderUnreadable,
  renderNone,
  renderPass,
  stopLine,
  isRunning,
  externalWork,
  pendingNote,
  runRows,
  checkFacts,
  verdictOf,
  type Verdict,
  failureIssues,
  type InfraCode,
  type Seen,
} from './pipeline-report';
import { finishedRuns, readFailures, readNotes, rerunJobs } from './ci-host';
import { ARTIFACTS } from '../contract/artifacts';
import { mergeRequestDetails, parseMergeRequests } from '../merge-request/merge-request-record';
import { finish } from './pipeline-result';
import { hasDraft, markReady } from './pipeline-draft';
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
    ARTIFACTS.mergeRequest,
  ];

  constructor(
    kernel: StepKernel,
    private readonly events: EventRepository,
    private readonly registry: CodeHostRegistry,
    private readonly rebase: RunRebase,
    private readonly runStop: RunStop,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { opened } = ctx;
    const env = this.config.env;
    const records = parsePipelineRefs(input.pipelineRef ?? '');
    const skipped = input.ciSkip?.trim() ?? '';
    if (records.length === 0 && skipped) {
      return finish('ok', this.report(opened, skipped), 'skipped', skipped);
    }
    this.registry.requiredCredentials(opened.run.codeHost);
    const host = this.registry.byName(opened.run.codeHost);
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
      seen = await awake.run(() => this.load(records, calls, host, false));
      verdict = verdictOf(seen);
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
    if (verdict === 'wait' && runRows(seen, isRunning).length === 0) {
      return this.stalled(ctx, env, records, seen, host, reruns);
    }
    if (verdict === 'wait') {
      const settled = await this.cancelRunning(records, seen, calls, env, host);
      if (!settled.traces) {
        return this.red(ctx, env, settled.seen, host, settled.note, false);
      }
      const next = verdictOf(settled.seen);
      if (next === 'red' || next === 'wait') {
        return this.red(ctx, env, settled.seen, host, settled.note, true);
      }
      seen = settled.seen;
      verdict = next;
    }
    if (verdict === 'red') {
      const cause = classify(seen);
      return cause === 'failed'
        ? this.red(ctx, env, seen, host)
        : this.infra(ctx, env, records, seen, cause === 'timeout' ? 'CI_TIMEOUT' : 'CI_NOT_RUN', host, reruns);
    }
    if (verdict === 'stop') {
      return finish('failed', this.report(opened, stopLine(seen)), 'failed');
    }
    if (verdict === 'manual') {
      return finish('waiting', this.report(opened, 'pipeline is manual'), 'waiting');
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
      return finish('ok', this.report(opened, 'nothing started', body), 'done', body);
    }
    const warnings = seen.flatMap((item) =>
      item.jobs
        .filter((job) => job.status === 'failed' && job.allowFailure)
        .map((job) => `${item.project} ${job.name}`),
    );
    const body = renderPass(seen, warnings);
    await markReady(ctx, this.registry);
    return finish('ok', this.report(opened, 'pipeline done', body), 'done', body);
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
      return this.red(ctx, env, seen, host, note, true);
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
    const pause = RERUN_PAUSES_MS[reruns];
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
    const notes = await readNotes(host, finished, calls);
    const body = `${renderInfra(code, seen, notes)}${errors.map((error) => `rerun: ${error}\n`).join('')}`;
    const result = finish(
      'blocked',
      this.report(opened, code === 'CI_TIMEOUT' ? 'CI timed out' : 'CI did not run', body),
      'blocked',
      body,
    );
    const issue = issueOf(CI_INFRA_SOURCE, code, body);
    return { ...result, outputs: [...result.outputs, { artifact: ARTIFACTS.issues, value: [issue] }] };
  }

  private async cancelRunning(
    records: PipelineRef[],
    seen: Seen[],
    calls: HttpCallDraft[],
    env: SwarmloopEnv,
    host: CodeHost,
  ): Promise<{ seen: Seen[]; note: string; traces: boolean }> {
    const minutes = Math.round(env.PIPELINE_TIMEOUT_MS / 60000);
    const running = runRows(seen, isRunning);
    const errors: string[] = [];
    for (const item of running) {
      try {
        const result = await host.cancelPipeline(item.project, item.id);
        calls.push(...result.httpCalls);
      } catch (error) {
        if (error instanceof FetchFailed) {
          calls.push(...error.httpCalls);
        }
        const message = error instanceof Error ? error.message : 'cancel failed';
        errors.push(`${item.project}: ${message}`);
      }
    }
    if (errors.length > 0) {
      let rows = running;
      try {
        const named = await this.load(records, calls, host);
        rows = running.map((item) => {
          return runRows(named, isRunning).find((row) => row.project === item.project && row.id === item.id) ?? item;
        });
      } catch (error) {
        if (error instanceof FetchFailed) {
          calls.push(...error.httpCalls);
        }
      }
      return { seen, note: cancelErrorNote(rows, errors), traces: false };
    }
    const awake = this.awakeTime(env);
    let current = seen;
    while (awake.elapsedMs() < env.PIPELINE_START_TIMEOUT_MS && runRows(current, isRunning).length > 0) {
      const pause = Math.min(env.TICK_MS, env.PIPELINE_START_TIMEOUT_MS - awake.elapsedMs());
      if (pause <= 0) {
        break;
      }
      await delay(pause);
      current = await awake.run(() => this.load(records, calls, host, false));
    }
    return {
      seen: current,
      note: `It was still running after ${minutes} minutes and swarmloop canceled it`,
      traces: true,
    };
  }

  private async red(
    ctx: StepContext,
    env: SwarmloopEnv,
    seen: Seen[],
    host: CodeHost,
    note = '',
    traces = true,
  ): Promise<StepResult> {
    const { opened, calls } = ctx;
    // A run swarmloop canceled itself (it comes with a note) has canceled jobs that are its failure; otherwise only failed jobs are.
    const counted = note ? ['failed', 'canceled', 'timed_out'] : ['failed'];
    const failures = traces ? await readFailures(seen, calls, host, counted) : [];
    const unreadable = renderUnreadable(failures);
    if (unreadable) {
      return finish('blocked', this.report(opened, 'pipeline log unavailable', unreadable), 'blocked', unreadable);
    }
    const body = traces ? renderFail(failures, seen, note) : `${note.trim()}\n`;
    if (ctx.options.auto && (await this.sameFailure(ctx, seen))) {
      const report = this.report(opened, 'pipeline already failed for this commit', body);
      return finish('failed', report, 'failed', body);
    }
    if (opened.run.attemptsPipeline >= env.MAX_PIPELINE_RETURNS) {
      const report = this.report(opened, 'pipeline return limit reached', body);
      return finish('blocked', report, 'blocked', body);
    }
    opened.run.attemptsPipeline += 1;
    const reason = failures.map((failure) => `${failure.project} ${failure.name}`).join(',') || 'pipeline failed';
    await this.events.recordLoop(opened.run, 'pipeline', opened.run.attemptsPipeline, reason);
    const issues = failureIssues(failures, body);
    return finish('waiting', this.report(opened, 'pipeline failed', body), 'waiting', body, issues);
  }

  private async sameFailure(ctx: StepContext, seen: Seen[]): Promise<boolean> {
    const previous = (await ctx.reread(ARTIFACTS.pipelineLog)) ?? '';
    const lines = new Set(previous.split('\n').map((line) => line.trim()));
    if (!lines.has('result: fail')) {
      return false;
    }
    const failed = seen.filter((item) => item.status === 'failed' || item.status === 'canceled');
    return failed.length > 0 && failed.every((item) => item.id !== null && lines.has(`pipeline: ${item.id}`));
  }

  private report(opened: OpenedStep, text: string, body = ''): string {
    const head = `${opened.startedAt} ${text}`;
    return body ? `${head}\n${body.trimEnd()}` : head;
  }
}

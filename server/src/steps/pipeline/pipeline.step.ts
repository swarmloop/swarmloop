import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunRebase } from '../run-rebase';
import { RunStop } from '../../agent/run-stop';
import { missingPipeline } from './missing-pipeline';
import { type SwarmloopEnv } from '../../config/env';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { EventRepository } from '../../history/event.repository';
import { root } from '../../history/run-paths';
import { delay } from '../../core/delay';
import type { StepName } from '../../contract/steps';
import type { OpenedStep } from '../../steps/step-run';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { FetchFailed, SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { returnNotes } from '../shared/handoff';
import { checkedRepoNames, hasCi, worktreePath } from '../../git/repo-names';
import { BaseStep, type StepContext } from '../base-step';
import {
  cancelErrorNote,
  originProject,
  parsePipelineRefs,
  renderFail,
  renderNone,
  renderPass,
  type Failure,
  type Seen,
} from './pipeline-report';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue, InputSpec, Route, StepInput, StepResult } from '../contract/step-contract';

type Verdict = 'green' | 'red' | 'wait' | 'manual' | 'stop' | 'absent';

/** `repos` is read only when a green or absent pipeline asks whether CI started, so it is loaded there. */
const INPUTS = {
  pipelineRef: { artifact: ARTIFACTS.pipelineRef, need: 'start' },
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional' },
  repos: { artifact: ARTIFACTS.repos, need: 'optional', late: true },
} as const satisfies InputSpec;

@Injectable()
export class PipelineStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'pipeline';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.pipelineLog, ARTIFACTS.return, ARTIFACTS.pipelineRebases];

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
      return this.finish('ok', this.report(opened, skipped), 'skipped', skipped);
    }
    this.registry.requiredCredentials(opened.run.codeHost);
    const host = this.registry.byName(opened.run.codeHost);
    if (records.length === 0) {
      throw new SwarmloopError('pipeline ref is missing');
    }
    const watched = await this.watch(ctx, records, env, host);
    return this.route(ctx, env, records, watched.seen, watched.verdict, host);
  }

  /** Repo names that have a workflow file and no run. Null when the repo list is missing. */
  private async missingRuns(ctx: StepContext, seen: Seen[]): Promise<string[] | null> {
    const lines = await ctx.reread(ARTIFACTS.repos);
    if (!lines || lines.length === 0) {
      return null;
    }
    let names: string[];
    try {
      names = checkedRepoNames(lines);
    } catch {
      return null;
    }
    const missing: string[] = [];
    for (const name of names) {
      const dir = worktreePath(root(this.config), ctx.opened.run.key, name);
      if (!hasCi(dir)) {
        continue;
      }
      const project = await originProject(dir);
      const run = project ? seen.find((item) => item.project === project) : undefined;
      if (!run || run.status === 'none') {
        missing.push(name);
      }
    }
    return missing;
  }

  private async watch(
    ctx: StepContext,
    records: PipelineRef[],
    env: SwarmloopEnv,
    host: CodeHost,
  ): Promise<{ seen: Seen[]; verdict: Verdict }> {
    const { calls } = ctx;
    const deadline = this.clock.now() + env.PIPELINE_TIMEOUT_MS;
    const startDeadline = this.clock.now() + env.PIPELINE_START_TIMEOUT_MS;
    let seen = await this.load(records, calls, host, false);
    let verdict = this.verdict(seen);
    while (this.clock.now() < deadline && (verdict === 'wait' || verdict === 'absent' || verdict === 'green')) {
      const missing = verdict === 'wait' ? null : await this.missingRuns(ctx, seen);
      if (verdict === 'green' && !(missing && missing.length > 0)) {
        break;
      }
      if (verdict === 'absent' && missing?.length === 0) {
        break;
      }
      const limit = verdict === 'wait' ? deadline : startDeadline;
      const pause = Math.min(env.TICK_MS, limit - this.clock.now());
      if (pause <= 0) {
        break;
      }
      await delay(pause);
      seen = await this.load(records, calls, host, false);
      verdict = this.verdict(seen);
    }
    return { seen, verdict };
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
          },
        };
      }),
    );
    for (const item of loaded) {
      calls.push(...item.result.httpCalls);
    }
    return loaded.map((item) => item.seen);
  }

  private verdict(seen: Seen[]): Verdict {
    const statuses = seen.map((item) => item.status);
    if (statuses.includes('failed') || statuses.includes('canceled')) {
      return 'red';
    }
    if (statuses.includes('skipped')) {
      return 'stop';
    }
    if (statuses.includes('manual')) {
      return 'manual';
    }
    const active = statuses.filter((status) => status !== 'none');
    if (active.length === 0) {
      return 'absent';
    }
    if (active.some((status) => status !== 'success')) {
      return 'wait';
    }
    return 'green';
  }

  private async route(
    ctx: StepContext,
    env: SwarmloopEnv,
    records: PipelineRef[],
    seen: Seen[],
    verdict: Verdict,
    host: CodeHost,
  ): Promise<StepResult> {
    const { opened, calls } = ctx;
    if (verdict === 'wait') {
      const settled = await this.cancelRunning(records, seen, calls, env, host);
      if (!settled.traces) {
        return this.red(ctx, env, settled.seen, host, settled.note, false);
      }
      const next = this.verdict(settled.seen);
      if (next === 'red' || next === 'wait') {
        return this.red(ctx, env, settled.seen, host, settled.note, true);
      }
      seen = settled.seen;
      verdict = next;
    }
    if (verdict === 'red') {
      return this.red(ctx, env, seen, host);
    }
    if (verdict === 'stop') {
      return this.finish('failed', this.report(opened, this.stopLine(seen)), 'failed');
    }
    if (verdict === 'manual') {
      return this.finish('waiting', this.report(opened, 'pipeline is manual'), 'waiting');
    }
    const missing = await this.missingRuns(ctx, seen);
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
    if (verdict === 'absent') {
      const body = renderNone(seen);
      return this.finish('ok', this.report(opened, 'nothing started', body), 'done', body);
    }
    const warnings = seen.flatMap((item) =>
      item.jobs
        .filter((job) => job.status === 'failed' && job.allowFailure)
        .map((job) => `${item.project} ${job.name}`),
    );
    const body = renderPass(seen, warnings);
    return this.finish('ok', this.report(opened, 'pipeline done', body), 'done', body);
  }

  private async cancelRunning(
    records: PipelineRef[],
    seen: Seen[],
    calls: HttpCallDraft[],
    env: SwarmloopEnv,
    host: CodeHost,
  ): Promise<{ seen: Seen[]; note: string; traces: boolean }> {
    const minutes = Math.round(env.PIPELINE_TIMEOUT_MS / 60000);
    const running = seen.filter((item) => this.running(item));
    const errors: string[] = [];
    for (const item of running) {
      if (item.id === null) {
        errors.push(`${item.project}: pipeline id is missing`);
        continue;
      }
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
          const next = named.find((row) => row.project === item.project);
          return next && next.id === item.id && this.running(next) ? next : item;
        });
      } catch (error) {
        if (error instanceof FetchFailed) {
          calls.push(...error.httpCalls);
        }
      }
      return { seen, note: cancelErrorNote(rows, errors), traces: false };
    }
    const deadline = this.clock.now() + env.PIPELINE_START_TIMEOUT_MS;
    let current = seen;
    while (this.clock.now() < deadline && current.some((item) => this.running(item))) {
      const pause = Math.min(env.TICK_MS, deadline - this.clock.now());
      if (pause <= 0) {
        break;
      }
      await delay(pause);
      current = await this.load(records, calls, host, false);
    }
    return {
      seen: current,
      note: `It was still running after ${minutes} minutes and swarmloop canceled it`,
      traces: true,
    };
  }

  private running(item: Seen): boolean {
    return !['none', 'success', 'failed', 'canceled', 'skipped', 'manual'].includes(item.status);
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
    const failures = traces ? await this.failures(seen, calls, host) : [];
    const body = traces ? renderFail(failures, seen, note) : `${note.trim()}\n`;
    if (ctx.options.auto && (await this.sameFailure(ctx, seen))) {
      const report = this.report(opened, 'pipeline already failed for this commit', body);
      return this.finish('failed', report, 'failed', body);
    }
    if (opened.run.attemptsPipeline >= env.MAX_PIPELINE_RETURNS) {
      const report = this.report(opened, 'pipeline return limit reached', body);
      return this.finish('blocked', report, 'blocked', body);
    }
    opened.run.attemptsPipeline += 1;
    const reason = failures.map((failure) => `${failure.project} ${failure.name}`).join(',') || 'pipeline failed';
    await this.events.recordLoop(opened.run, 'pipeline', opened.run.attemptsPipeline, reason);
    return this.finish('waiting', this.report(opened, 'pipeline failed', body), 'waiting', body, 'implement');
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

  private async failures(seen: Seen[], calls: HttpCallDraft[], host: CodeHost): Promise<Failure[]> {
    const wanted = seen.flatMap((item) =>
      (item.status !== 'failed' && item.status !== 'canceled') || item.id === null
        ? []
        : item.jobs
            .filter((job) => job.status === 'failed' && !job.allowFailure)
            .map((job) => ({ project: item.project, pipelineId: item.id as number, url: item.url, job })),
    );
    const loaded = await Promise.all(
      wanted.map(async (item) => {
        try {
          const trace = await host.readJobTrace(item.project, item.job.id);
          return { item, trace: trace.trace, calls: trace.httpCalls };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'pipeline failed';
          return { item, trace: message, calls: error instanceof FetchFailed ? error.httpCalls : [] };
        }
      }),
    );
    const failures: Failure[] = [];
    for (const row of loaded) {
      calls.push(...row.calls);
      failures.push({
        project: row.item.project,
        pipelineId: row.item.pipelineId,
        name: row.item.job.name,
        stage: row.item.job.stage,
        url: row.item.url,
        trace: row.trace,
      });
    }
    return failures;
  }

  private stopLine(seen: Seen[]): string {
    const project = seen.find((item) => item.status === 'skipped')?.project ?? 'pipeline';
    return `${project} pipeline was skipped`;
  }

  private report(opened: OpenedStep, text: string, body = ''): string {
    const head = `${opened.startedAt} ${text}`;
    return body ? `${head}\n${body.trimEnd()}` : head;
  }

  private finish(
    outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
    line: string,
    visitStatus: string,
    body?: string,
    moveTo?: 'implement',
  ): StepResult {
    const outputs: ArtifactValue[] = [];
    if (body) {
      outputs.push({ artifact: ARTIFACTS.pipelineLog, value: body });
    }
    if (moveTo && body) {
      outputs.push({ artifact: ARTIFACTS.return, value: returnNotes([{ source: 'pipeline', body }]).body });
    }
    let handoff: string | undefined;
    if (outcome === 'ok' || moveTo) {
      const head = moveTo
        ? 'Pipeline failed and returned to implement.'
        : body?.includes('CI skipped')
          ? body.trim()
          : body?.includes('result: none')
            ? 'Nothing started.'
            : 'Pipeline passed.';
      handoff = `- ${head}\n`;
    }
    return { route: routeOf(outcome, line, moveTo), summary: line, outputs, handoff, visit: { status: visitStatus } };
  }
}

function routeOf(outcome: 'ok' | 'failed' | 'blocked' | 'waiting', line: string, moveTo?: 'implement'): Route {
  switch (outcome) {
    case 'ok':
      return { to: 'next' };
    case 'failed':
      return { to: 'fail', error: { code: 'pipeline', message: line } };
    case 'blocked':
      return { to: 'block', reason: line };
    case 'waiting':
      return moveTo ? { to: 'return', step: moveTo, issues: [] } : { to: 'wait', reason: line };
  }
}

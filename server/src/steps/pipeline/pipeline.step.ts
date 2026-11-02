import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { readEnv, type SwarmloopEnv } from '../../config/env';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { HistoryService } from '../../history/history.service';
import type { DocumentDraft } from '../../history/visit';
import type { PipelineResult, StepName, StepOptions } from '../../core/pipeline-result';
import type { OpenedStep } from '../../pipeline/step-run';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { FetchFailed, SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { recordHandoff, returnNotes, textDocument } from '../shared/handoff';
import { git } from '../../git/git';
import { remoteProject } from '../merge-request/merge-request-record';
import { repoNames, worktreePath } from '../shared/repo-names';
import { BaseStep, type StepContext } from '../base-step';
import {
  cancelErrorNote,
  parsePipelineRefs,
  renderFail,
  renderNone,
  renderPass,
  type Failure,
  type Seen,
} from './pipeline-report';

type Verdict = 'green' | 'red' | 'wait' | 'manual' | 'stop' | 'absent';

@Injectable()
export class PipelineStep extends BaseStep {
  readonly name: StepName = 'pipeline';
  readonly requiredKind = 'pipeline_ref';

  constructor(
    history: HistoryService,
    private readonly config: ConfigService,
    private readonly registry: CodeHostRegistry,
  ) {
    super(history);
  }

  protected async run(key: string, options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    const { opened, calls } = ctx;
    const env = readEnv(this.config);
    const records = parsePipelineRefs((await this.history.latestBody(key, 'pipeline_ref')) ?? '');
    const skipped = (await this.history.latestBody(key, 'ci_skip'))?.trim() ?? '';
    if (records.length === 0 && skipped) {
      return this.finish(ctx, 'ok', 0, this.report(opened, skipped), 'skipped', skipped);
    }
    this.registry.requiredCredentials(opened.run.codeHost);
    const host = this.registry.byName(opened.run.codeHost);
    if (records.length === 0) {
      throw new SwarmloopError('pipeline ref is missing');
    }
    const watched = await this.watch(opened.run.key, records, calls, env, host);
    return this.route(ctx, env, records, watched.seen, watched.verdict, host, options);
  }

  /** Repo names that have a workflow file and no run. Null when the repo list is missing. */
  private async missingRuns(key: string, seen: Seen[]): Promise<string[] | null> {
    const raw = await this.history.latestBody(key, 'repos');
    if (!raw?.trim()) {
      return null;
    }
    let names: string[];
    try {
      names = repoNames(raw);
    } catch {
      return null;
    }
    const missing: string[] = [];
    for (const name of names) {
      const dir = worktreePath(this.history.root(), key, name);
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
    key: string,
    records: PipelineRef[],
    calls: HttpCallDraft[],
    env: SwarmloopEnv,
    host: CodeHost,
  ): Promise<{ seen: Seen[]; verdict: Verdict }> {
    const deadline = Date.now() + env.PIPELINE_TIMEOUT_MS;
    const startDeadline = Date.now() + env.PIPELINE_START_TIMEOUT_MS;
    let seen = await this.load(records, calls, host, false);
    let verdict = this.verdict(seen);
    while (Date.now() < deadline && (verdict === 'wait' || verdict === 'absent' || verdict === 'green')) {
      const missing = verdict === 'wait' ? null : await this.missingRuns(key, seen);
      if (verdict === 'green' && !(missing && missing.length > 0)) {
        break;
      }
      if (verdict === 'absent' && missing?.length === 0) {
        break;
      }
      const limit = verdict === 'wait' ? deadline : startDeadline;
      const pause = Math.min(env.TICK_MS, limit - Date.now());
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
    options: StepOptions,
  ): Promise<PipelineResult> {
    const { opened, calls } = ctx;
    if (verdict === 'wait') {
      const settled = await this.cancelRunning(records, seen, calls, env, host);
      if (!settled.traces) {
        return this.red(ctx, env, settled.seen, host, options, settled.note, false);
      }
      const next = this.verdict(settled.seen);
      if (next === 'red' || next === 'wait') {
        return this.red(ctx, env, settled.seen, host, options, settled.note, true);
      }
      seen = settled.seen;
      verdict = next;
    }
    if (verdict === 'red') {
      return this.red(ctx, env, seen, host, options);
    }
    if (verdict === 'stop') {
      return this.finish(ctx, 'failed', 1, this.report(opened, this.stopLine(seen)), 'failed');
    }
    if (verdict === 'manual') {
      return this.finish(ctx, 'waiting', 0, this.report(opened, 'pipeline is manual'), 'waiting');
    }
    const missing = await this.missingRuns(opened.run.key, seen);
    if (missing && missing.length > 0) {
      const line = missing.map((name) => `${name} CI did not start`).join(', ');
      return this.finish(ctx, 'failed', 1, this.report(opened, line), 'failed');
    }
    if (verdict === 'absent') {
      const body = renderNone(seen);
      return this.finish(ctx, 'ok', 0, this.report(opened, 'nothing started', body), 'done', body);
    }
    const warnings = seen.flatMap((item) =>
      item.jobs.filter((job) => job.status === 'failed' && job.allowFailure).map((job) => `${item.project} ${job.name}`),
    );
    const body = renderPass(seen, warnings);
    return this.finish(ctx, 'ok', 0, this.report(opened, 'pipeline done', body), 'done', body);
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
    const deadline = Date.now() + env.PIPELINE_START_TIMEOUT_MS;
    let current = seen;
    while (Date.now() < deadline && current.some((item) => this.running(item))) {
      const pause = Math.min(env.TICK_MS, deadline - Date.now());
      if (pause <= 0) {
        break;
      }
      await delay(pause);
      current = await this.load(records, calls, host, false);
    }
    return { seen: current, note: `It was still running after ${minutes} minutes and swarmloop canceled it`, traces: true };
  }

  private running(item: Seen): boolean {
    return !['none', 'success', 'failed', 'canceled', 'skipped', 'manual'].includes(item.status);
  }

  private async red(
    ctx: StepContext,
    env: SwarmloopEnv,
    seen: Seen[],
    host: CodeHost,
    options: StepOptions,
    note = '',
    traces = true,
  ): Promise<PipelineResult> {
    const { opened, calls } = ctx;
    const failures = traces ? await this.failures(seen, calls, host) : [];
    const body = traces ? renderFail(failures, seen, note) : `${note.trim()}\n`;
    if (options.auto && (await this.sameFailure(opened.run.key, seen))) {
      return this.finish(ctx, 'failed', 1, this.report(opened, 'pipeline already failed for this commit', body), 'failed', body);
    }
    if (opened.run.attemptsPipeline >= env.MAX_PIPELINE_RETURNS) {
      return this.finish(ctx, 'blocked', 1, this.report(opened, 'pipeline return limit reached', body), 'blocked', body);
    }
    opened.run.attemptsPipeline += 1;
    const reason = failures.map((failure) => `${failure.project} ${failure.name}`).join(',') || 'pipeline failed';
    await this.history.recordLoop(opened.run, 'pipeline', opened.run.attemptsPipeline, reason);
    return this.finish(ctx, 'waiting', 0, this.report(opened, 'pipeline failed', body), 'waiting', body, 'implement');
  }

  private async sameFailure(key: string, seen: Seen[]): Promise<boolean> {
    const previous = (await this.history.latestBody(key, 'pipeline_log')) ?? '';
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

  private async finish(
    ctx: StepContext,
    outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
    exitCode: number,
    line: string,
    visitStatus: string,
    body?: string,
    moveTo?: 'implement',
  ): Promise<PipelineResult> {
    const { opened } = ctx;
    const docs: DocumentDraft[] = [];
    if (body) {
      docs.push(textDocument('pipeline_log', body));
    }
    if (moveTo && body) {
      docs.push(returnNotes([{ source: 'pipeline', body }]));
    }
    if (outcome === 'ok' || moveTo) {
      const head = moveTo
        ? 'Pipeline failed and returned to implement.'
        : body?.includes('CI skipped')
          ? body.trim()
          : body?.includes('result: none')
            ? 'Nothing started.'
            : 'Pipeline passed.';
      docs.push(await recordHandoff(this.history, opened.run.key, 'pipeline', `- ${head}\n`));
    }
    return ctx.end({
      outcome,
      exitCode,
      line,
      status: visitStatus,
      moveTo,
      visit: { documents: docs.length > 0 ? docs : undefined },
    });
  }
}

async function originProject(dir: string): Promise<string | null> {
  try {
    return remoteProject(await git(['-C', dir, 'remote', 'get-url', 'origin'])).project;
  } catch {
    return null;
  }
}

function hasCi(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return false;
  }
  if (existsSync(join(dir, '.gitlab-ci.yml'))) {
    return true;
  }
  const workflows = join(dir, '.github', 'workflows');
  if (!existsSync(workflows) || !statSync(workflows).isDirectory()) {
    return false;
  }
  return readdirSync(workflows).some((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

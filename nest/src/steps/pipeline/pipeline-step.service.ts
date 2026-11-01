import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { readEnv, SwarmloopEnv } from '../../config/env';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, sampleSelf } from '../../history/visit';
import { PipelineResult, StepName, StepOptions } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { CodeHost, PipelineJob, PipelineRef } from '../../integrations/code-host/code-host';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../swarmloop-error';
import { recordHandoff, returnNotes, textDocument } from '../model-step';
import { git } from '../../git/git';
import { remoteProject } from '../merge-request/merge-request-record';
import { repoNames, worktreePath } from '../repo-names';
import { Step, requiredDocument } from '../step';

type Verdict = 'green' | 'red' | 'wait' | 'manual' | 'stop' | 'absent';

interface Seen {
  project: string;
  id: number | null;
  sha: string;
  url: string;
  status: string;
  jobs: PipelineJob[];
}

interface Failure {
  project: string;
  pipelineId: number;
  name: string;
  stage: string;
  url: string;
  trace: string;
}

@Injectable()
export class PipelineStepService implements Step {
  readonly name: StepName = 'pipeline';
  readonly usesModel = false;

  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly registry: CodeHostRegistry,
  ) {}

  missingInput(key: string): Promise<string | null> {
    return requiredDocument(this.history, key, 'pipeline_ref');
  }

  async execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'pipeline');
    const env = readEnv(this.config);
    const calls: HttpCallDraft[] = [];
    try {
      const records = parsePipelineRefs((await this.history.latestBody(key, 'pipeline_ref')) ?? '');
      const skipped = (await this.history.latestBody(key, 'ci_skip'))?.trim() ?? '';
      if (records.length === 0 && skipped) {
        return await this.finish(opened, 'ok', 0, this.report(opened, skipped), 'skipped', calls, skipped);
      }
      this.registry.requiredCredentials(opened.run.codeHost);
      const host = this.registry.byName(opened.run.codeHost);
      if (records.length === 0) {
        throw new SwarmloopError('pipeline ref is missing');
      }
      const watched = await this.watch(opened.run.key, records, calls, env, host);
      return await this.route(opened, env, records, watched.seen, watched.verdict, calls, host, options);
    } catch (error) {
      if (error instanceof FetchFailed) {
        calls.push(...error.httpCalls);
      }
      const message = error instanceof SwarmloopError ? error.message : 'pipeline failed';
      return this.finish(opened, 'failed', 1, this.report(opened, message), 'failed', calls);
    }
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
    opened: OpenedStep,
    env: SwarmloopEnv,
    records: PipelineRef[],
    seen: Seen[],
    verdict: Verdict,
    calls: HttpCallDraft[],
    host: CodeHost,
    options: StepOptions,
  ): Promise<PipelineResult> {
    if (verdict === 'wait') {
      const settled = await this.cancelRunning(records, seen, calls, env, host);
      if (!settled.traces) {
        return this.red(opened, env, settled.seen, calls, host, options, settled.note, false);
      }
      const next = this.verdict(settled.seen);
      if (next === 'red' || next === 'wait') {
        return this.red(opened, env, settled.seen, calls, host, options, settled.note, true);
      }
      seen = settled.seen;
      verdict = next;
    }
    if (verdict === 'red') {
      return this.red(opened, env, seen, calls, host, options);
    }
    if (verdict === 'stop') {
      return this.finish(opened, 'failed', 1, this.report(opened, this.stopLine(seen)), 'failed', calls);
    }
    if (verdict === 'manual') {
      return this.finish(opened, 'waiting', 0, this.report(opened, 'pipeline is manual'), 'waiting', calls);
    }
    const missing = await this.missingRuns(opened.run.key, seen);
    if (missing && missing.length > 0) {
      const line = missing.map((name) => `${name} CI did not start`).join(', ');
      return this.finish(opened, 'failed', 1, this.report(opened, line), 'failed', calls);
    }
    if (verdict === 'absent') {
      const body = renderNone(seen);
      return this.finish(opened, 'ok', 0, this.report(opened, 'nothing started', body), 'done', calls, body);
    }
    const warnings = seen.flatMap((item) =>
      item.jobs.filter((job) => job.status === 'failed' && job.allowFailure).map((job) => `${item.project} ${job.name}`),
    );
    const body = renderPass(seen, warnings);
    return this.finish(opened, 'ok', 0, this.report(opened, 'pipeline done', body), 'done', calls, body);
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
    opened: OpenedStep,
    env: SwarmloopEnv,
    seen: Seen[],
    calls: HttpCallDraft[],
    host: CodeHost,
    options: StepOptions,
    note = '',
    traces = true,
  ): Promise<PipelineResult> {
    const failures = traces ? await this.failures(seen, calls, host) : [];
    const body = traces ? renderFail(failures, seen, note) : `${note.trim()}\n`;
    if (options.auto && (await this.sameFailure(opened.run.key, seen))) {
      return this.finish(opened, 'failed', 1, this.report(opened, 'pipeline already failed for this commit', body), 'failed', calls, body);
    }
    if (opened.run.attemptsPipeline >= env.MAX_PIPELINE_RETURNS) {
      return this.finish(opened, 'blocked', 1, this.report(opened, 'pipeline return limit reached', body), 'blocked', calls, body);
    }
    opened.run.attemptsPipeline += 1;
    const reason = failures.map((failure) => `${failure.project} ${failure.name}`).join(',') || 'pipeline failed';
    await this.history.recordLoop(opened.run, 'pipeline', opened.run.attemptsPipeline, reason);
    return this.finish(opened, 'waiting', 0, this.report(opened, 'pipeline failed', body), 'waiting', calls, body, 'implement');
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
    opened: OpenedStep,
    outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
    exitCode: number,
    line: string,
    visitStatus: string,
    calls: HttpCallDraft[],
    body?: string,
    moveTo?: 'implement',
  ): Promise<PipelineResult> {
    const now = new Date().toISOString();
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
    return closeStep({
      history: this.history,
      run: opened.run,
      previousStep: opened.previousStep,
      previousStatus: opened.previousStatus,
      step: 'pipeline',
      outcome,
      exitCode,
      line,
      moveTo,
      visit: {
        step: 'pipeline',
        model: null,
        mode: null,
        startedAt: opened.startedAt,
        finishedAt: now,
        durationMs: Date.now() - opened.started,
        status: visitStatus,
        exitCode,
        killReason: null,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        samples: [sampleSelf()],
        exchange: null,
        httpCalls: calls,
        document: null,
        documents: docs.length > 0 ? docs : undefined,
        resumed: false,
      },
    });
  }
}

function renderNone(seen: Seen[]): string {
  const lines = ['result: none', 'nothing started'];
  for (const item of seen) {
    lines.push(`project: ${item.project}`);
  }
  return `${lines.join('\n')}\n`;
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

function renderPass(seen: Seen[], warnings: string[]): string {
  const lines = ['result: pass'];
  for (const item of seen) {
    lines.push(`project: ${item.project}`);
    if (item.id) {
      lines.push(`pipeline: ${item.id}`);
    }
    if (item.sha) {
      lines.push(`sha: ${item.sha}`);
    }
  }
  lines.push(...warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join('\n')}\n`;
}

function renderFail(failures: Failure[], seen: Seen[], intro = ''): string {
  const head = intro.trim() ? `${intro.trim()}\n` : '';
  if (failures.length === 0) {
    const failed = seen
      .filter((item) => item.status === 'failed' || item.status === 'canceled')
      .map((item) =>
        [`project: ${item.project}`, `pipeline: ${item.id ?? ''}`, `status: ${item.status}`, item.url ? `url: ${item.url}` : '']
          .filter((line) => line !== '')
          .join('\n'),
      );
    return `${head}result: fail\n${failed.join('\n\n')}\n`;
  }
  const blocks = failures.map((failure) => {
    const lines = [
      `project: ${failure.project}`,
      `pipeline: ${failure.pipelineId}`,
      `job: ${failure.name}`,
      `stage: ${failure.stage}`,
    ];
    if (failure.url) {
      lines.push(`url: ${failure.url}`);
    }
    return `${lines.join('\n')}\n\n${readableJobTrace(failure.trace)}`;
  });
  return `${head}result: fail\n${blocks.join('\n\n')}\n`;
}

function cancelErrorNote(running: Seen[], errors: string[]): string {
  const lines = ['result: fail'];
  for (const item of running) {
    lines.push(`project: ${item.project}`);
    if (item.id !== null) {
      lines.push(`pipeline: ${item.id}`);
    }
    if (item.url) {
      lines.push(`url: ${item.url}`);
    }
    const names = item.jobs.map((job) => job.name).filter((name) => name !== '');
    lines.push(...(names.length > 0 ? names.map((name) => `job: ${name}`) : ['job: running']));
  }
  lines.push(...errors.map((error) => `cancel: ${error}`));
  return lines.join('\n');
}

const READABLE_LINES = 200;
const READABLE_CHARS = 20000;

export function readableJobTrace(raw: string): string {
  const rawLines = raw.split(/\r?\n/);
  const section = rawLines.findIndex((line) => line.includes('section_end:') && line.includes('step_script'));
  let end = rawLines.length;
  if (section >= 0) {
    end = section + 1;
  } else {
    for (let index = rawLines.length - 1; index >= 0; index -= 1) {
      if (rawLines[index].includes('##[error]')) {
        end = index + 1;
        break;
      }
    }
  }
  return cleanTrace(rawLines.slice(0, end).join('\n')).slice(-READABLE_LINES).join('\n').slice(-READABLE_CHARS);
}

function cleanTrace(raw: string): string[] {
  return raw
    .replace(/\u001b(?:\[[0-9;?]*[A-Za-z]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, ''))
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'trace truncated') {
        return false;
      }
      if (trimmed.includes('section_start:') || trimmed.includes('section_end:')) {
        return false;
      }
      if (/^[.*]+$/.test(trimmed) || /^\* test /.test(trimmed)) {
        return false;
      }
      if (/^Compiling \d+ files/.test(trimmed) || /^Generated /.test(trimmed)) {
        return false;
      }
      return true;
    });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePipelineRefs(body: string): PipelineRef[] {
  const records: PipelineRef[] = [];
  let project = '';
  let ref = '';
  let sha = '';
  const flush = (): void => {
    if (project && ref) {
      records.push({ project, ref, sha });
    }
    project = '';
    ref = '';
    sha = '';
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('project: ')) {
      if (project || ref) {
        flush();
      }
      project = line.slice('project: '.length).trim();
    } else if (line.startsWith('ref: ')) {
      ref = line.slice('ref: '.length).trim();
    } else if (line.startsWith('sha: ')) {
      sha = line.slice('sha: '.length).trim();
    }
  }
  flush();
  return records;
}

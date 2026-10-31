import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { readEnv, SwarmloopEnv } from '../../config/env';
import { CodeHosts } from '../../providers/code-hosts';
import { requireHostCredentials } from '../../providers/host-credentials';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, sampleSelf } from '../../history/visit';
import { PipelineResult, StepOptions } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { CodeHost, PipelineJob, PipelineRef } from '../../providers/contracts';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../swarmloop-error';
import { recordHandoff, returnNotes, textDocument } from '../model-step';
import { git } from '../../git/git';
import { remoteProject } from '../merge-request/merge-request-record';
import { repoNames, worktreePath } from '../repo-names';

type Verdict = 'green' | 'red' | 'wait' | 'manual' | 'stop' | 'absent';

interface Seen {
  project: string;
  id: number | null;
  sha: string;
  status: string;
  jobs: PipelineJob[];
}

interface Failure {
  project: string;
  pipelineId: number;
  name: string;
  stage: string;
  trace: string;
}

@Injectable()
export class PipelineStepService {
  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly hosts: CodeHosts,
  ) {}

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
      this.credentials(env, opened.run.codeHost);
      const host = this.hosts.get(opened.run.codeHost);
      if (records.length === 0) {
        throw new SwarmloopError('pipeline ref is missing');
      }
      const watched = await this.watch(opened.run.key, records, calls, env, host);
      return await this.route(opened, env, watched.seen, watched.verdict, calls, host, options);
    } catch (error) {
      if (error instanceof FetchFailed) {
        calls.push(...error.httpCalls);
      }
      const message = error instanceof SwarmloopError ? error.message : 'pipeline failed';
      return this.finish(opened, 'failed', 1, this.report(opened, message), 'failed', calls);
    }
  }

  private credentials(env: SwarmloopEnv, name: string): void {
    requireHostCredentials(env, name);
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
    let seen = await this.load(records, calls, host);
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
      seen = await this.load(records, calls, host);
      verdict = this.verdict(seen);
    }
    return { seen, verdict };
  }

  private async load(records: PipelineRef[], calls: HttpCallDraft[], host: CodeHost): Promise<Seen[]> {
    const loaded = await Promise.all(
      records.map(async (record) => {
        const result = await host.readBranchPipeline(record);
        return {
          result,
          seen: {
            project: record.project,
            id: result.snapshot?.id ?? null,
            sha: record.sha ?? '',
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
    if (statuses.includes('failed')) {
      return 'red';
    }
    if (statuses.some((status) => status === 'canceled' || status === 'skipped')) {
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
    seen: Seen[],
    verdict: Verdict,
    calls: HttpCallDraft[],
    host: CodeHost,
    options: StepOptions,
  ): Promise<PipelineResult> {
    if (verdict === 'absent') {
      const body = renderNone(seen);
      return this.finish(opened, 'ok', 0, this.report(opened, 'nothing started', body), 'done', calls, body);
    }
    if (verdict === 'green') {
      const warnings = seen.flatMap((item) =>
        item.jobs.filter((job) => job.status === 'failed' && job.allowFailure).map((job) => `${item.project} ${job.name}`),
      );
      const body = renderPass(seen, warnings);
      return this.finish(opened, 'ok', 0, this.report(opened, 'pipeline done', body), 'done', calls, body);
    }
    if (verdict === 'red') {
      return this.red(opened, env, seen, calls, host, options);
    }
    if (verdict === 'stop') {
      return this.finish(opened, 'failed', 1, this.report(opened, this.stopLine(seen)), 'failed', calls);
    }
    const line = verdict === 'manual' ? 'pipeline is manual' : this.waitLine(seen);
    return this.finish(opened, 'waiting', 0, this.report(opened, line), 'waiting', calls);
  }

  private async red(opened: OpenedStep, env: SwarmloopEnv, seen: Seen[], calls: HttpCallDraft[], host: CodeHost, options: StepOptions): Promise<PipelineResult> {
    const failures = await this.failures(seen, calls, host);
    const body = renderFail(failures, seen);
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
    const failed = seen.filter((item) => item.status === 'failed');
    return failed.length > 0 && failed.every((item) => item.id !== null && lines.has(`pipeline: ${item.id}`));
  }

  private async failures(seen: Seen[], calls: HttpCallDraft[], host: CodeHost): Promise<Failure[]> {
    const wanted = seen.flatMap((item) =>
      item.status !== 'failed' || item.id === null
        ? []
        : item.jobs
            .filter((job) => job.status === 'failed' && !job.allowFailure)
            .map((job) => ({ project: item.project, pipelineId: item.id as number, job })),
    );
    const loaded = await Promise.all(
      wanted.map(async (item) => {
        const trace = await host.readJobTrace(item.project, item.job.id);
        return { item, trace };
      }),
    );
    const failures: Failure[] = [];
    for (const row of loaded) {
      calls.push(...row.trace.httpCalls);
      failures.push({
        project: row.item.project,
        pipelineId: row.item.pipelineId,
        name: row.item.job.name,
        stage: row.item.job.stage,
        trace: row.trace.trace,
      });
    }
    return failures;
  }

  private waitLine(seen: Seen[]): string {
    return seen.every((item) => item.status === 'none') ? 'pipeline has not started' : 'pipeline is running';
  }

  private stopLine(seen: Seen[]): string {
    const canceled = seen.find((item) => item.status === 'canceled');
    const project = (canceled ?? seen.find((item) => item.status === 'skipped'))?.project ?? 'pipeline';
    return `${project} pipeline was ${canceled ? 'canceled' : 'skipped'}`;
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

function renderFail(failures: Failure[], seen: Seen[]): string {
  if (failures.length === 0) {
    const failed = seen.filter((item) => item.status === 'failed').map((item) => `project: ${item.project}\npipeline: ${item.id ?? ''}`);
    return `result: fail\n${failed.join('\n\n')}\n`;
  }
  const blocks = failures.map(
    (failure) =>
      `project: ${failure.project}\npipeline: ${failure.pipelineId}\njob: ${failure.name}\nstage: ${failure.stage}\n\n${readableJobTrace(failure.trace)}`,
  );
  return `result: fail\n${blocks.join('\n\n')}\n`;
}

const READABLE_LINES = 200;

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
  return cleanTrace(rawLines.slice(0, end).join('\n')).slice(-READABLE_LINES).join('\n');
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

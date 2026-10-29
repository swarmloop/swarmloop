import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../../config/env';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../swarmloop-error';
import { CodeHost, MergeRequestDraft, MergeRequestQuery, MergeRequestRecord, PipelineJob, PipelineRef, PipelineSnapshot } from '../contracts';
import { request } from '../http';

interface GithubPull {
  number?: number;
  html_url?: string;
  body?: string | null;
  head?: { ref?: string };
}

interface GithubRun {
  id?: number;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

@Injectable()
export class GithubHostService implements CodeHost {
  constructor(private readonly config: ConfigService) {}

  async findMergeRequest(query: MergeRequestQuery): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { api, headers } = this.credentials();
      const owner = query.project.split('/')[0] ?? '';
      const url = `${api}/repos/${repoPath(query.project)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${query.source}`)}&per_page=20`;
      const body = await this.readJson(url, headers, calls);
      const row = this.match(body, query.source);
      return { record: row ? this.record(query.project, row) : null, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async openMergeRequest(draft: MergeRequestDraft): Promise<{ record: MergeRequestRecord; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(draft.project)}/pulls`;
      const payload = JSON.stringify({
        title: draft.title.slice(0, 256),
        head: draft.source,
        base: draft.target,
        body: draft.summary,
      });
      const body = await this.readJson(url, { ...headers, 'Content-Type': 'application/json' }, calls, payload);
      return { record: this.record(draft.project, body as GithubPull, draft.summary), httpCalls: calls };
    } catch (error) {
      const reused = await this.reuse(draft, error, calls);
      if (reused) {
        return reused;
      }
      this.rethrow(error, calls);
    }
  }

  async updateMergeRequest(project: string, iid: number, summary: string): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/pulls/${iid}`;
      const payload = JSON.stringify({ body: summary });
      const response = await request(url, { ...headers, 'Content-Type': 'application/json' }, calls, { method: 'PATCH', body: payload });
      this.assertStatus(response.status, calls, 'github pull request failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readBranchPipeline(ref: PipelineRef): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { api, headers } = this.credentials();
      const project = repoPath(ref.project);
      const body = await this.readJson(
        `${api}/repos/${project}/actions/runs?branch=${encodeURIComponent(ref.ref)}&per_page=20`,
        headers,
        calls,
        undefined,
        'github pipeline failed',
      );
      const run = newestRun(body, ref.sha ?? '');
      if (!run?.id) {
        return { snapshot: null, httpCalls: calls };
      }
      const status = runStatus(run);
      const jobs = status === 'success' || status === 'failed' ? await this.failedJobs(api, headers, project, run.id, calls) : [];
      return { snapshot: { id: run.id, status, url: run.html_url ?? '', jobs }, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/actions/jobs/${jobId}/logs`;
      const response = await request(url, headers, calls);
      this.assertStatus(response.status, calls, 'github pipeline failed');
      return { trace: response.body.toString('utf8'), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  private credentials(): { api: string; headers: Record<string, string> } {
    const env = readEnv(this.config);
    const missing = (['GITHUB_BASE_URL', 'GITHUB_TOKEN'] as const).find((name) => !env[name]);
    if (missing) {
      throw new SwarmloopError(`${missing} is missing`);
    }
    let api: string;
    try {
      api = apiRoot(env.GITHUB_BASE_URL);
    } catch {
      throw new SwarmloopError('GITHUB_BASE_URL is not a url');
    }
    return {
      api,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'swarmloop',
      },
    };
  }

  private async readJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
    failure = 'github pull request failed',
  ): Promise<unknown> {
    const response = await request(url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    this.assertStatus(response.status, calls, failure);
    try {
      return JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(failure, calls);
    }
  }

  private assertStatus(status: number, calls: HttpCallDraft[], failure: string): void {
    if (status === 401 || status === 403) {
      throw new FetchFailed('GITHUB_TOKEN was rejected', calls);
    }
    if (status < 200 || status >= 300) {
      throw new FetchFailed(`${failure}: HTTP ${status}`, calls);
    }
  }

  private async failedJobs(
    api: string,
    headers: Record<string, string>,
    project: string,
    runId: number,
    calls: HttpCallDraft[],
  ): Promise<PipelineJob[]> {
    const response = await request(`${api}/repos/${project}/actions/runs/${runId}/jobs?per_page=100`, headers, calls);
    this.assertStatus(response.status, calls, 'github pipeline failed');
    let body: unknown;
    try {
      body = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed('github pipeline failed', calls);
    }
    const jobs = (body as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(jobs)) {
      throw new FetchFailed('github pipeline failed', calls);
    }
    return jobs.flatMap((row) => {
      const job = asJob(row);
      return job?.status === 'failed' ? [job] : [];
    });
  }

  private async reuse(
    draft: MergeRequestDraft,
    error: unknown,
    calls: HttpCallDraft[],
  ): Promise<{ record: MergeRequestRecord; httpCalls: HttpCallDraft[] } | null> {
    if (!this.conflict(error, calls)) {
      return null;
    }
    try {
      const found = await this.findMergeRequest({ project: draft.project, source: draft.source });
      if (!found.record) {
        return null;
      }
      const updated = await this.updateMergeRequest(draft.project, found.record.iid, draft.summary);
      return { record: { ...found.record, summary: draft.summary }, httpCalls: [...calls, ...found.httpCalls, ...updated.httpCalls] };
    } catch (foundError) {
      if (foundError instanceof FetchFailed) {
        throw new FetchFailed(foundError.message, [...calls, ...foundError.httpCalls]);
      }
      throw foundError;
    }
  }

  private match(body: unknown, source: string): GithubPull | null {
    if (!Array.isArray(body)) {
      throw new SwarmloopError('github pull request failed');
    }
    const row = body.find((item) => (item as GithubPull | null)?.head?.ref === source);
    return (row as GithubPull | undefined) ?? null;
  }

  private conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 422 || call.statusCode === 409);
  }

  private record(project: string, row: GithubPull, summary = row.body ?? ''): MergeRequestRecord {
    if (!row.number || !row.html_url) {
      throw new SwarmloopError('github pull request failed');
    }
    return { project, iid: row.number, url: row.html_url, summary };
  }

  private rethrow(error: unknown, calls: HttpCallDraft[]): never {
    if (error instanceof FetchFailed) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'github pull request failed';
    if (error instanceof SwarmloopError && calls.length === 0) {
      throw error;
    }
    throw new FetchFailed(message, calls);
  }
}

function repoPath(project: string): string {
  return project
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function apiRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    return 'https://api.github.com';
  }
  return `${url.origin}/api/v3`;
}

function runStatus(run: GithubRun): string {
  if (run.status !== 'completed') {
    return 'running';
  }
  if (run.conclusion === 'success' || run.conclusion === 'neutral') {
    return 'success';
  }
  if (run.conclusion === 'cancelled') {
    return 'canceled';
  }
  if (run.conclusion === 'skipped') {
    return 'skipped';
  }
  if (run.conclusion === 'action_required') {
    return 'manual';
  }
  return 'failed';
}

function newestRun(body: unknown, sha: string): GithubRun | null {
  const runs = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new SwarmloopError('github pipeline failed');
  }
  const match = runs.find((item) => {
    const run = item as GithubRun | null;
    return run?.id && (!sha || run.head_sha === sha);
  });
  return (match as GithubRun | undefined) ?? null;
}

function asJob(row: unknown): PipelineJob | null {
  const job = row as { id?: number; name?: string; conclusion?: string | null; status?: string } | null;
  if (!job?.id) {
    return null;
  }
  const status = job.conclusion === 'failure' || job.conclusion === 'timed_out' ? 'failed' : (job.conclusion ?? job.status ?? '');
  return { id: job.id, name: job.name ?? String(job.id), stage: '', status, allowFailure: false };
}

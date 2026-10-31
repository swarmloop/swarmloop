import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwarmloopEnv } from '../../../config/env';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../../swarmloop-error';
import { request } from '../../../providers/http';
import { AbstractCodeHost } from '../abstract-code-host';
import { MergeRequestDraft, MergeRequestQuery, MergeRequestRecord, PipelineJob, PipelineRef, PipelineSnapshot } from '../code-host';

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
export class GithubCodeHost extends AbstractCodeHost {
  constructor(config: ConfigService) {
    super(config, 'github pull request failed', 'GITHUB_TOKEN was rejected');
  }

  async readBranchPipeline(ref: PipelineRef): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
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
      const jobs = loadsJobs(status) ? await this.failedJobs(api, headers, project, run.id, calls) : [];
      return { snapshot: { id: run.id, status, url: run.html_url ?? '', jobs }, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/actions/runs/${id}/cancel`;
      const response = await request(url, headers, calls, { method: 'POST' });
      this.assertStatus(response.status, calls, 'github pipeline failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/actions/jobs/${jobId}/logs`;
      const response = await request(url, headers, calls);
      this.assertStatus(response.status, calls, 'github pipeline failed');
      return { trace: response.body.toString('utf8'), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  protected credentialKeys(): readonly (keyof SwarmloopEnv)[] {
    return ['GITHUB_BASE_URL', 'GITHUB_TOKEN'];
  }

  protected endpoint(env: SwarmloopEnv): { root: string; headers: Record<string, string> } {
    let api: string;
    try {
      api = apiRoot(env.GITHUB_BASE_URL);
    } catch {
      throw new SwarmloopError('GITHUB_BASE_URL is not a url');
    }
    return {
      root: api,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'swarmloop',
      },
    };
  }

  protected findUrl(root: string, query: MergeRequestQuery): string {
    const owner = query.project.split('/')[0] ?? '';
    return `${root}/repos/${repoPath(query.project)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${query.source}`)}&per_page=20`;
  }

  protected openRequest(root: string, draft: MergeRequestDraft): { url: string; payload: string } {
    return {
      url: `${root}/repos/${repoPath(draft.project)}/pulls`,
      payload: JSON.stringify({
        title: draft.title.slice(0, 256),
        head: draft.source,
        base: draft.target,
        body: draft.summary,
      }),
    };
  }

  protected updateRequest(root: string, project: string, iid: number, summary: string): { url: string; method: string; payload: string } {
    return {
      url: `${root}/repos/${repoPath(project)}/pulls/${iid}`,
      method: 'PATCH',
      payload: JSON.stringify({ body: summary }),
    };
  }

  protected match(body: unknown, source: string): GithubPull | null {
    if (!Array.isArray(body)) {
      throw new SwarmloopError('github pull request failed');
    }
    const row = body.find((item) => (item as GithubPull | null)?.head?.ref === source);
    return (row as GithubPull | undefined) ?? null;
  }

  protected record(project: string, row: unknown, summary?: string): MergeRequestRecord {
    const pull = row as GithubPull;
    const text = summary ?? pull.body ?? '';
    if (!pull.number || !pull.html_url) {
      throw new SwarmloopError('github pull request failed');
    }
    return { project, iid: pull.number, url: pull.html_url, summary: text };
  }

  protected conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 422 || call.statusCode === 409);
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
      return job ? [job] : [];
    });
  }
}

function loadsJobs(status: string): boolean {
  return status === 'success' || status === 'failed' || status === 'canceled' || status === 'running';
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
  if (job.conclusion === 'failure' || job.conclusion === 'timed_out' || job.conclusion === 'cancelled') {
    return { id: job.id, name: job.name ?? String(job.id), stage: '', status: 'failed', allowFailure: false };
  }
  if (job.status && job.status !== 'completed') {
    return { id: job.id, name: job.name ?? String(job.id), stage: '', status: job.status, allowFailure: false };
  }
  return null;
}

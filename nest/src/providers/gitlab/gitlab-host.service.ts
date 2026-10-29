import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../../config/env';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../swarmloop-error';
import { CodeHost, MergeRequestDraft, MergeRequestQuery, MergeRequestRecord, PipelineJob, PipelineRef, PipelineSnapshot } from '../contracts';
import { request } from '../http';

interface GitlabMergeRequest {
  iid?: number;
  web_url?: string;
  description?: string | null;
  source_branch?: string;
}

@Injectable()
export class GitlabHostService implements CodeHost {
  constructor(private readonly config: ConfigService) {}

  async findMergeRequest(query: MergeRequestQuery): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(query.project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(query.source)}`;
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
      const { base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(draft.project)}/merge_requests`;
      const payload = JSON.stringify({
        source_branch: draft.source,
        target_branch: draft.target,
        title: draft.title.slice(0, 255),
        description: draft.summary,
      });
      const body = await this.readJson(url, { ...headers, 'Content-Type': 'application/json' }, calls, payload);
      return { record: this.record(draft.project, body as GitlabMergeRequest, draft.summary), httpCalls: calls };
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
      const { base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
      const payload = JSON.stringify({ description: summary });
      const response = await request(url, { ...headers, 'Content-Type': 'application/json' }, calls, { method: 'PUT', body: payload });
      this.assertStatus(response.status, calls, 'gitlab merge request failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readBranchPipeline(ref: PipelineRef): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { base, headers } = this.credentials();
      const project = encodeURIComponent(ref.project);
      const list = await this.readJson(
        `${base}/api/v4/projects/${project}/pipelines?ref=${encodeURIComponent(ref.ref)}&per_page=100&order_by=id&sort=desc`,
        headers,
        calls,
        undefined,
        'gitlab pipeline failed',
      );
      const id = newestPipeline(list, ref.sha ?? '');
      if (!id) {
        return { snapshot: null, httpCalls: calls };
      }
      const detail = (await this.readJson(
        `${base}/api/v4/projects/${project}/pipelines/${id}`,
        headers,
        calls,
        undefined,
        'gitlab pipeline failed',
      )) as GitlabPipeline;
      const status = detail.status ?? '';
      const jobs = status === 'success' || status === 'failed' ? await this.failedJobs(base, headers, project, id, calls) : [];
      return { snapshot: { id, status, url: detail.web_url ?? '', jobs }, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/jobs/${jobId}/trace`;
      const trace = await this.readText(url, { ...headers, Accept: 'text/plain' }, calls, 'gitlab pipeline failed');
      return { trace, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  private credentials(): { base: string; headers: Record<string, string> } {
    const env = readEnv(this.config);
    const missing = (['GITLAB_BASE_URL', 'GITLAB_TOKEN'] as const).find((name) => !env[name]);
    if (missing) {
      throw new SwarmloopError(`${missing} is missing`);
    }
    return {
      base: env.GITLAB_BASE_URL.replace(/\/$/, ''),
      headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN, Accept: 'application/json' },
    };
  }

  private async readJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
    failure = 'gitlab merge request failed',
  ): Promise<unknown> {
    const response = await request(url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    this.assertStatus(response.status, calls, failure);
    try {
      return JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(failure, calls);
    }
  }

  private async readText(url: string, headers: Record<string, string>, calls: HttpCallDraft[], failure: string): Promise<string> {
    const response = await request(url, headers, calls);
    this.assertStatus(response.status, calls, failure);
    return response.body.toString('utf8');
  }

  private parseJson(body: Buffer, calls: HttpCallDraft[]): unknown {
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed('gitlab pipeline failed', calls);
    }
  }

  private assertStatus(status: number, calls: HttpCallDraft[], failure: string): void {
    if (status === 401 || status === 403) {
      throw new FetchFailed('GITLAB_TOKEN was rejected', calls);
    }
    if (status < 200 || status >= 300) {
      throw new FetchFailed(`${failure}: HTTP ${status}`, calls);
    }
  }

  private async failedJobs(
    base: string,
    headers: Record<string, string>,
    project: string,
    pipelineId: number,
    calls: HttpCallDraft[],
  ): Promise<PipelineJob[]> {
    const jobs: PipelineJob[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 10; page += 1) {
      const params = new URLSearchParams();
      params.set('per_page', '100');
      params.set('page', String(page));
      params.set('include_retried', 'false');
      params.append('scope[]', 'failed');
      const url = `${base}/api/v4/projects/${project}/pipelines/${pipelineId}/jobs?${params.toString()}`;
      const response = await request(url, headers, calls);
      this.assertStatus(response.status, calls, 'gitlab pipeline failed');
      const body = this.parseJson(response.body, calls);
      if (!Array.isArray(body)) {
        throw new FetchFailed('gitlab pipeline failed', calls);
      }
      for (const row of body) {
        const job = asJob(row);
        if (job && !seen.has(job.id)) {
          seen.add(job.id);
          jobs.push(job);
        }
      }
      if (!response.headers.get('x-next-page')) {
        return jobs;
      }
    }
    throw new FetchFailed('gitlab pipeline failed', calls);
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

  private match(body: unknown, source: string): GitlabMergeRequest | null {
    if (!Array.isArray(body)) {
      throw new SwarmloopError('gitlab merge request failed');
    }
    const row = body.find((item) => (item as GitlabMergeRequest | null)?.source_branch === source);
    return (row as GitlabMergeRequest | undefined) ?? null;
  }

  private conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 409);
  }

  private record(project: string, row: GitlabMergeRequest, summary = row.description ?? ''): MergeRequestRecord {
    if (!row.iid || !row.web_url) {
      throw new SwarmloopError('gitlab merge request failed');
    }
    return { project, iid: row.iid, url: row.web_url, summary };
  }

  private rethrow(error: unknown, calls: HttpCallDraft[]): never {
    if (error instanceof FetchFailed) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'gitlab merge request failed';
    if (error instanceof SwarmloopError && calls.length === 0) {
      throw error;
    }
    throw new FetchFailed(message, calls);
  }
}

interface GitlabPipeline {
  id?: number;
  sha?: string;
  status?: string;
  web_url?: string;
}

interface GitlabJob {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  retried?: boolean;
}

function newestPipeline(body: unknown, sha = ''): number | null {
  if (!Array.isArray(body)) {
    throw new SwarmloopError('gitlab pipeline failed');
  }
  const ids = body
    .map((item) => item as GitlabPipeline | null)
    .filter((item) => item?.id && (!sha || item.sha === sha))
    .map((item) => item?.id ?? 0);
  if (ids.length === 0) {
    return null;
  }
  return Math.max(...ids);
}

function asJob(row: unknown): PipelineJob | null {
  const job = row as GitlabJob | null;
  if (!job?.id || job.retried === true) {
    return null;
  }
  return {
    id: job.id,
    name: job.name ?? String(job.id),
    stage: job.stage ?? '',
    status: job.status ?? 'failed',
    allowFailure: job.allow_failure === true,
  };
}

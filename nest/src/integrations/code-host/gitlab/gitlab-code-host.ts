import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwarmloopEnv } from '../../../config/env';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../../swarmloop-error';
import { request } from '../../../providers/http';
import { AbstractCodeHost } from '../abstract-code-host';
import { MergeRequestDraft, MergeRequestQuery, MergeRequestRecord, PipelineJob, PipelineRef, PipelineSnapshot } from '../code-host';

interface GitlabMergeRequest {
  iid?: number;
  web_url?: string;
  description?: string | null;
  source_branch?: string;
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

@Injectable()
export class GitlabCodeHost extends AbstractCodeHost {
  constructor(config: ConfigService) {
    super(config, 'gitlab merge request failed', 'GITLAB_TOKEN was rejected');
  }

  async readBranchPipeline(ref: PipelineRef): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
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
      const { root: base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/jobs/${jobId}/trace`;
      const trace = await this.readText(url, { ...headers, Accept: 'text/plain' }, calls, 'gitlab pipeline failed');
      return { trace, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  protected credentialKeys(): readonly (keyof SwarmloopEnv)[] {
    return ['GITLAB_BASE_URL', 'GITLAB_TOKEN'];
  }

  protected endpoint(env: SwarmloopEnv): { root: string; headers: Record<string, string> } {
    return {
      root: env.GITLAB_BASE_URL.replace(/\/$/, ''),
      headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN, Accept: 'application/json' },
    };
  }

  protected findUrl(root: string, query: MergeRequestQuery): string {
    return `${root}/api/v4/projects/${encodeURIComponent(query.project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(query.source)}`;
  }

  protected openRequest(root: string, draft: MergeRequestDraft): { url: string; payload: string } {
    return {
      url: `${root}/api/v4/projects/${encodeURIComponent(draft.project)}/merge_requests`,
      payload: JSON.stringify({
        source_branch: draft.source,
        target_branch: draft.target,
        title: draft.title.slice(0, 255),
        description: draft.summary,
      }),
    };
  }

  protected updateRequest(root: string, project: string, iid: number, summary: string): { url: string; method: string; payload: string } {
    return {
      url: `${root}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
      method: 'PUT',
      payload: JSON.stringify({ description: summary }),
    };
  }

  protected match(body: unknown, source: string): GitlabMergeRequest | null {
    if (!Array.isArray(body)) {
      throw new SwarmloopError('gitlab merge request failed');
    }
    const row = body.find((item) => (item as GitlabMergeRequest | null)?.source_branch === source);
    return (row as GitlabMergeRequest | undefined) ?? null;
  }

  protected record(project: string, row: unknown, summary?: string): MergeRequestRecord {
    const merge = row as GitlabMergeRequest;
    const text = summary ?? merge.description ?? '';
    if (!merge.iid || !merge.web_url) {
      throw new SwarmloopError('gitlab merge request failed');
    }
    return { project, iid: merge.iid, url: merge.web_url, summary: text };
  }

  protected conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 409);
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

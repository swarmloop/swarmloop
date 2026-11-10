import type { Clock } from '../../../core/clock';
import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { request } from '../../http';
import { remoteProject } from '../remote-project';
import { AbstractCodeHost, type CodeHostEnv } from '../abstract-code-host';
import type {
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  PipelineJob,
  PipelineRef,
  PipelineSnapshot,
  PipelineDiagnosis,
  SelectedHost,
} from '../code-host';

interface GitlabMergeRequest {
  iid?: number;
  web_url?: string;
  description?: string | null;
  source_branch?: string;
  sha?: string;
  state?: string;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
}

interface GitlabPipeline {
  id?: number;
  sha?: string;
  status?: string;
  web_url?: string;
  failure_reason?: string;
  yaml_errors?: string;
}

interface GitlabJob {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  retried?: boolean;
}

export class GitlabCodeHost extends AbstractCodeHost {
  readonly name = 'gitlab' as const;

  constructor(env: CodeHostEnv, clock: Clock) {
    super(env, clock, 'gitlab merge request failed', 'GITLAB_TOKEN was rejected');
  }

  matchesOrigin(origin: string): boolean {
    return this.remoteOnBase(origin, this.env.GITLAB_BASE_URL) !== null;
  }

  pushUrl(origin: string): string | null {
    const token = this.env.GITLAB_TOKEN;
    if (!token.trim()) {
      return null;
    }
    try {
      const host = new URL(this.env.GITLAB_BASE_URL).hostname.toLowerCase();
      const remote = remoteProject(origin);
      if (remote.host.toLowerCase() !== host) {
        return null;
      }
      return `https://oauth2:${token}@${host}/${remote.project}.git`;
    } catch {
      return null;
    }
  }

  selected(): SelectedHost {
    return {
      name: this.name,
      baseUrl: this.env.GITLAB_BASE_URL,
      token: this.env.GITLAB_TOKEN,
      baseKey: 'GITLAB_BASE_URL',
      tokenKey: 'GITLAB_TOKEN',
    };
  }

  async readBranchPipeline(
    ref: PipelineRef,
    jobs = true,
  ): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
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
      const scopes = jobScopes(status);
      const listed =
        scopes && (jobs || scopes.includes('failed'))
          ? await this.failedJobs(base, headers, project, id, scopes, calls)
          : [];
      return { snapshot: { id, status, url: detail.web_url ?? '', jobs: listed }, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async diagnoseMissingPipeline(ref: PipelineRef): Promise<PipelineDiagnosis> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const url = `${root}/api/v4/projects/${encodeURIComponent(ref.project)}/merge_requests`;
      const list = await this.readJson(
        `${url}?state=all&source_branch=${encodeURIComponent(ref.ref)}&with_merge_status_recheck=true&per_page=100`,
        headers,
        calls,
      );
      if (!Array.isArray(list)) throw new SwarmloopError('gitlab pipeline diagnosis failed');
      const found = (list as GitlabMergeRequest[]).find(
        (mr) => mr.source_branch === ref.ref && (!ref.sha || mr.sha === ref.sha),
      );
      if (!found?.iid) return { reason: null, httpCalls: calls };
      const mr = (await this.readJson(`${url}/${found.iid}`, headers, calls)) as GitlabMergeRequest;
      if (mr.source_branch !== ref.ref || (ref.sha && mr.sha !== ref.sha)) return { reason: null, httpCalls: calls };
      const link = mr.web_url ?? `MR !${found.iid}`;
      if (mr.state === 'closed' || mr.state === 'merged')
        return { reason: `${link} is ${mr.state}.`, code: 'closed', httpCalls: calls };
      if (ref.sha && mr.state === 'opened' && (mr.has_conflicts === true || mr.detailed_merge_status === 'conflict')) {
        return {
          reason: `${link} has merge conflicts with its target branch.`,
          code: 'merge-conflict',
          httpCalls: calls,
        };
      }
      return { reason: null, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/pipelines/${id}/cancel`;
      const response = await request(this.clock, url, headers, calls, { method: 'POST' });
      this.assertStatus(response, calls, 'gitlab pipeline failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async rerunFailedJobs(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/pipelines/${id}/retry`;
      const response = await request(this.clock, url, headers, calls, { method: 'POST' });
      this.assertStatus(response, calls, 'gitlab pipeline failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readRunNotes(project: string, id: number): Promise<{ notes: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/pipelines/${id}`;
      const detail = (await this.readJson(url, headers, calls, undefined, 'gitlab pipeline failed')) as GitlabPipeline;
      const notes = [detail.failure_reason, detail.yaml_errors].filter(Boolean).join(' ');
      return { notes, httpCalls: calls };
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

  protected credentialKeys(): readonly (keyof CodeHostEnv)[] {
    return ['GITLAB_BASE_URL', 'GITLAB_TOKEN'];
  }

  protected endpoint(env: CodeHostEnv): { root: string; headers: Record<string, string> } {
    return {
      root: env.GITLAB_BASE_URL.replace(/\/$/, ''),
      headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN, Accept: 'application/json' },
    };
  }

  protected userUrl(root: string): string {
    return `${root}/api/v4/user`;
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

  protected updateRequest(
    root: string,
    project: string,
    iid: number,
    summary: string,
  ): { url: string; method: string; payload: string } {
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
    const row = (body as unknown[]).find((item) => (item as GitlabMergeRequest | null)?.source_branch === source);
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

  private async readText(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    failure: string,
  ): Promise<string> {
    const response = await request(this.clock, url, headers, calls);
    this.assertStatus(response, calls, failure);
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
    scopes: string[],
    calls: HttpCallDraft[],
  ): Promise<PipelineJob[]> {
    const jobs: PipelineJob[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 10; page += 1) {
      const params = new URLSearchParams();
      params.set('per_page', '100');
      params.set('page', String(page));
      params.set('include_retried', 'false');
      for (const scope of scopes) {
        params.append('scope[]', scope);
      }
      const url = `${base}/api/v4/projects/${project}/pipelines/${pipelineId}/jobs?${params.toString()}`;
      const response = await request(this.clock, url, headers, calls);
      this.assertStatus(response, calls, 'gitlab pipeline failed');
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

function jobScopes(status: string): string[] | null {
  if (status === 'success') {
    return ['failed'];
  }
  if (status === 'failed' || status === 'canceled') {
    return ['failed', 'canceled', 'created', 'pending', 'waiting_for_resource'];
  }
  if (status === 'skipped' || status === 'manual' || status === '') {
    return null;
  }
  return ['running', 'pending'];
}

function asJob(row: unknown): PipelineJob | null {
  const job = row as GitlabJob | null;
  if (!job?.id || job.retried === true) {
    return null;
  }
  const canceled = job.status === 'canceled' || job.status === 'cancelled';
  const status = canceled ? 'canceled' : (job.status ?? 'failed');
  if (status === 'success' || status === 'skipped' || status === 'manual') {
    return null;
  }
  return {
    id: job.id,
    name: job.name ?? String(job.id),
    stage: job.stage ?? '',
    status,
    allowFailure: canceled ? false : job.allow_failure === true,
  };
}

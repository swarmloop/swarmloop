import type { Clock } from '../../../core/clock';
import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { request } from '../../http';
import { remoteProject } from '../remote-project';
import { snapshotOf } from '../check-status';
import {
  asJob,
  jobCheck,
  jobScopes,
  pipelineStatus,
  statusCheck,
  type GitlabJob,
  type GitlabStatus,
} from './gitlab-checks';
import { gitlabRepositories } from './gitlab-repositories';
import { AbstractCodeHost, type CodeHostEnv, type HostCall } from '../abstract-code-host';
import type {
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  MergeRequestView,
  PipelineCheck,
  PipelineRef,
  PipelineRun,
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
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  state?: string;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  title?: string;
  draft?: boolean;
}

interface GitlabPipeline {
  id?: number;
  sha?: string;
  status?: string;
  web_url?: string;
  failure_reason?: string;
  yaml_errors?: string;
}

/** GitLab's own draft marker: a title that starts with it. */
const DRAFT_PREFIX = 'Draft: ';

function isDraft(merge: GitlabMergeRequest): boolean {
  return merge.draft === true || (merge.title ?? '').startsWith(DRAFT_PREFIX);
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

  cloneUrl(project: string): string {
    return `${this.env.GITLAB_BASE_URL.replace(/\/$/, '')}/${project}.git`;
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
      const newest = await this.readJson(
        `${base}/api/v4/projects/${project}/pipelines?ref=${encodeURIComponent(ref.ref)}${ref.sha ? `&sha=${encodeURIComponent(ref.sha)}` : ''}&per_page=100&order_by=id&sort=desc`,
        headers,
        calls,
        undefined,
        'gitlab pipeline failed',
      );
      const pipelines = pipelinesOf(newest, ref.sha ?? '');
      const sha = ref.sha || pipelines[0]?.sha;
      const runs: PipelineRun[] = [];
      const checks: PipelineCheck[] = [];
      const jobIds = new Set<number>();
      for (const { id } of pipelines) {
        const detail = (await this.readJson(
          `${base}/api/v4/projects/${project}/pipelines/${id}`,
          headers,
          calls,
          undefined,
          'gitlab pipeline failed',
        )) as GitlabPipeline;
        const rows = (await this.allPages(
          `${base}/api/v4/projects/${project}/pipelines/${id}/jobs?include_retried=false`,
          headers,
          calls,
        )) as GitlabJob[];
        const scopes = jobScopes(detail.status ?? '');
        const listed = scopes && (jobs || scopes.includes('failed')) ? rows.flatMap((row) => asJob(row) ?? []) : [];
        rows.forEach((row) => jobIds.add(row.id ?? 0));
        checks.push(...rows.filter((row) => row.retried !== true).map(jobCheck));
        runs.push({
          id: id as number,
          status: pipelineStatus(detail.status),
          url: detail.web_url ?? '',
          jobs: listed.filter(
            (job, at) => scopes?.includes(job.status) && listed.findIndex((j) => j.id === job.id) === at,
          ),
        });
      }
      if (sha) {
        const statuses = (await this.allPages(
          `${base}/api/v4/projects/${project}/repository/commits/${encodeURIComponent(sha)}/statuses`,
          headers,
          calls,
        )) as GitlabStatus[];
        checks.push(...statuses.filter((row) => !jobIds.has(row.id ?? 0)).map(statusCheck));
      }
      return { snapshot: snapshotOf(runs, checks, []), httpCalls: calls };
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

  async setDraft(project: string, iid: number, draft: boolean): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const url = this.mergeRequestUrl(root, project, iid);
      const merge = (await this.readJson(url, headers, calls)) as GitlabMergeRequest;
      if (isDraft(merge) === draft) {
        return { httpCalls: calls };
      }
      const bare = (merge.title ?? '').replace(/^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i, '');
      const response = await request(this.clock, url, { ...headers, 'Content-Type': 'application/json' }, calls, {
        method: 'PUT',
        body: JSON.stringify({ title: draft ? `${DRAFT_PREFIX}${bare}` : bare }),
      });
      this.assertStatus(response, calls, 'gitlab merge request failed');
      return { httpCalls: calls };
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

  protected readonly repositories = gitlabRepositories;

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
        title: (draft.draft ? `${DRAFT_PREFIX}${draft.title}` : draft.title).slice(0, 255),
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

  protected mergeRequestUrl(root: string, project: string, iid: number): string {
    return `${root}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
  }

  protected mergeCall(root: string, project: string, iid: number): HostCall {
    return {
      url: `${this.mergeRequestUrl(root, project, iid)}/merge`,
      method: 'PUT',
      payload: JSON.stringify({ squash: true }),
    };
  }

  protected closeCall(root: string, project: string, iid: number): HostCall {
    return {
      url: this.mergeRequestUrl(root, project, iid),
      method: 'PUT',
      payload: JSON.stringify({ state_event: 'close' }),
    };
  }

  protected deleteCall(root: string, project: string, branch: string): HostCall {
    return {
      url: `${root}/api/v4/projects/${encodeURIComponent(project)}/repository/branches/${encodeURIComponent(branch)}`,
      method: 'DELETE',
    };
  }

  protected view(body: unknown): MergeRequestView {
    const merge = (body ?? {}) as GitlabMergeRequest;
    const merged = merge.state === 'merged';
    return {
      state: merged ? 'merged' : merge.state === 'closed' ? 'closed' : 'open',
      sha: merged ? this.mergedSha(merge) : null,
      conflicts: merge.has_conflicts === true || merge.detailed_merge_status === 'conflict',
      draft: isDraft(merge),
    };
  }

  protected mergedSha(body: unknown): string | null {
    const merge = (body ?? {}) as GitlabMergeRequest;
    return merge.merge_commit_sha ?? merge.squash_commit_sha ?? merge.sha ?? null;
  }

  protected mergeConflicts(status: number, message: string): boolean {
    return (status === 405 || status === 406) && /conflict|cannot be merged/i.test(message);
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
    return { project, iid: merge.iid, url: merge.web_url, summary: text, draft: isDraft(merge) };
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

  /** Every row of a list, following the pages GitLab announces. */
  private async allPages(url: string, headers: Record<string, string>, calls: HttpCallDraft[]): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const joiner = url.includes('?') ? '&' : '?';
      const response = await request(this.clock, `${url}${joiner}per_page=100&page=${page}`, headers, calls);
      this.assertStatus(response, calls, 'gitlab pipeline failed');
      const body = this.parseJson(response.body, calls);
      if (!Array.isArray(body)) {
        throw new FetchFailed('gitlab pipeline failed', calls);
      }
      rows.push(...(body as unknown[]));
      if (!response.headers.get('x-next-page')) {
        return rows;
      }
    }
    throw new FetchFailed('gitlab pipeline failed', calls);
  }
}

/** The pipelines of one commit, newest first: those of `sha`, or of the newest pipeline's commit when there is no sha. */
function pipelinesOf(body: unknown, sha: string): GitlabPipeline[] {
  if (!Array.isArray(body)) {
    throw new SwarmloopError('gitlab pipeline failed');
  }
  const rows = (body as (GitlabPipeline | null)[])
    .filter((item): item is GitlabPipeline => Boolean(item?.id))
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  const head = sha || rows[0]?.sha;
  return rows.filter((item) => !head || item.sha === head);
}

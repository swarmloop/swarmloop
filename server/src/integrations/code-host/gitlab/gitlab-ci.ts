import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { newestPerWorkflow, snapshotOf } from '../check-status';
import {
  asJob,
  jobCheck,
  jobScopes,
  pipelineStatus,
  statusCheck,
  type GitlabJob,
  type GitlabStatus,
} from './gitlab-checks';
import { GitlabMergeRequests } from './gitlab-merge-requests';
import type { PipelineCheck, PipelineRef, PipelineRun, PipelineSnapshot } from '../code-host';

interface GitlabPipeline {
  id?: number;
  sha?: string;
  status?: string;
  web_url?: string;
  source?: string;
  failure_reason?: string;
  yaml_errors?: string;
}

/** The detail statuses of a pipeline that has not started. */
const QUEUED = ['pending', 'created', 'waiting_for_resource'];

/** The CI of a GitLab project: its pipelines, jobs and commit statuses. */
export abstract class GitlabCi extends GitlabMergeRequests {
  protected readonly ciAccess = 'read_api scope and at least the Reporter role';

  /** True when the project's CI is on and its default branch has a CI configuration, read through the API. */
  async ciEnabled(project: string): Promise<boolean> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}`;
      const body = (await this.readCiJson(project, url, headers, calls, 'gitlab pipeline failed')) as {
        builds_access_level?: string;
        default_branch?: string;
        ci_config_path?: string | null;
      } | null;
      if (!body?.builds_access_level) {
        throw this.ciRefused('the project answer has no builds_access_level', project, calls);
      }
      if (body.builds_access_level === 'disabled') return false;
      if (!body.default_branch) {
        throw this.ciRefused('the project answer has no default_branch', project, calls);
      }
      const path = body.ci_config_path || '.gitlab-ci.yml';
      // A configuration in another project or at a url is not a file of this repository.
      if (path.includes('@') || /^https?:\/\//.test(path)) return true;
      const file = `${url}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(body.default_branch)}`;
      const response = await this.hostRequest(file, headers, calls);
      if (response.status === 403) throw this.ciRefused('HTTP 403', project, calls);
      if (response.status === 404) return false;
      this.assertStatus(response, calls, 'gitlab pipeline failed');
      return true;
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readBranchHasPipeline(ref: PipelineRef): Promise<{ found: boolean; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const listed = await this.readCiJson(
        ref.project,
        `${base}/api/v4/projects/${encodeURIComponent(ref.project)}/pipelines?ref=${encodeURIComponent(ref.ref)}&per_page=1`,
        headers,
        calls,
        'gitlab pipeline failed',
      );
      return { found: pipelinesOf(listed, '').length > 0, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readBranchPipeline(
    ref: PipelineRef,
    jobs = true,
  ): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const project = encodeURIComponent(ref.project);
      const newest = await this.readCiJson(
        ref.project,
        `${base}/api/v4/projects/${project}/pipelines?ref=${encodeURIComponent(ref.ref)}${ref.sha ? `&sha=${encodeURIComponent(ref.sha)}` : ''}&per_page=100&order_by=id&sort=desc`,
        headers,
        calls,
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
          ...(pipelineStatus(detail.status) === 'running'
            ? { total: rows.length, queued: QUEUED.includes(detail.status ?? '') }
            : {}),
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

  async cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: base, headers } = this.credentials();
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/pipelines/${id}/cancel`;
      const response = await this.hostRequest(url, headers, calls, { method: 'POST' });
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
      const response = await this.hostRequest(url, headers, calls, { method: 'POST' });
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

  private parseJson(body: Buffer, calls: HttpCallDraft[]): unknown {
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed('gitlab pipeline failed', calls);
    }
  }

  /** Every row of a list, following the pages GitLab announces. */
  protected async allPages(url: string, headers: Record<string, string>, calls: HttpCallDraft[]): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const joiner = url.includes('?') ? '&' : '?';
      const response = await this.hostRequest(`${url}${joiner}per_page=100&page=${page}`, headers, calls);
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
  // A merge-request pipeline and a branch pipeline of one commit are different workflows.
  return newestPerWorkflow(
    rows.filter((item) => !head || item.sha === head),
    (item) => item.source ?? '',
    (item) => item.id ?? 0,
  );
}

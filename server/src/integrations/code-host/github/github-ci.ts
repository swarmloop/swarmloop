import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed } from '../../../core/swarmloop-error';
import { snapshotOf } from '../check-status';
import { GithubMergeRequests, repoPath } from './github-merge-requests';
import {
  asJob,
  awaitedChecks,
  checkStatus,
  listJobs,
  parentHasChecks,
  readChecks,
  runsOf,
  type GithubRun,
} from './github-checks';
import type { PipelineJob, PipelineRef, PipelineRun, PipelineSnapshot } from '../code-host';

/** The CI of a GitHub repository: its Actions runs, checks and statuses. */
export abstract class GithubCi extends GithubMergeRequests {
  protected readonly ciAccess = 'Actions, Checks and Commit statuses read access (repo scope for a classic token)';

  /** True when the repository has Actions workflows, or its default branch head carries checks or statuses of another CI. */
  async ciEnabled(project: string): Promise<boolean> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const repo = `${api}/repos/${repoPath(project)}`;
      const failure = 'github pipeline failed';
      const read = (url: string): Promise<unknown> => this.readCiJson(project, url, headers, calls, failure);
      const workflows = (await read(`${repo}/actions/workflows?per_page=1`)) as { total_count?: number } | null;
      if ((workflows?.total_count ?? 0) > 0) return true;
      const head = await this.readDefaultHead(project);
      calls.push(...head.httpCalls);
      return (await readChecks(read, repo, head.sha, [])).length > 0;
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readBranchHasPipeline(ref: PipelineRef): Promise<{ found: boolean; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const repo = `${api}/repos/${repoPath(ref.project)}`;
      const body = await this.readCiJson(
        ref.project,
        `${repo}/actions/runs?branch=${encodeURIComponent(ref.ref)}&per_page=1`,
        headers,
        calls,
        'github pipeline failed',
      );
      if (runsOf(body, '').length > 0) return { found: true, httpCalls: calls };
      const read = (url: string): Promise<unknown> =>
        this.readJson(url, headers, calls, undefined, 'github pipeline failed');
      return { found: await parentHasChecks(read, repo, ref.sha || ref.ref), httpCalls: calls };
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
      const { root: api, headers } = this.credentials();
      const project = repoPath(ref.project);
      const body = await this.readCiJson(
        ref.project,
        `${api}/repos/${project}/actions/runs?branch=${encodeURIComponent(ref.ref)}&per_page=20`,
        headers,
        calls,
        'github pipeline failed',
      );
      const runs = runsOf(body, ref.sha ?? '');
      const rows: PipelineRun[] = [];
      for (const run of runs) {
        const status = checkStatus(run);
        const { listed, total } = listJobs(status, jobs || run.status === 'queued')
          ? await this.failedJobs(api, headers, project, run.id as number, calls)
          : { listed: [], total: undefined };
        const named =
          runs.length > 1 ? listed.map((job) => ({ ...job, name: `${run.name ?? 'workflow'} / ${job.name}` })) : listed;
        rows.push({
          id: run.id as number,
          status,
          url: run.html_url ?? '',
          jobs: named,
          ...(status === 'running' ? { total, queued: run.status === 'queued' } : {}),
        });
      }
      const read = (url: string): Promise<unknown> =>
        this.readJson(url, headers, calls, undefined, 'github pipeline failed');
      const checks = await readChecks(read, `${api}/repos/${project}`, ref.sha || runs[0]?.head_sha || ref.ref, runs);
      return { snapshot: snapshotOf(rows, checks, awaitedChecks(runs, checks)), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/actions/runs/${id}/cancel`;
      const response = await this.hostRequest(url, headers, calls, { method: 'POST' });
      this.assertStatus(response, calls, 'github pipeline failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async rerunFailedJobs(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/actions/runs/${id}/rerun-failed-jobs`;
      const response = await this.hostRequest(url, headers, calls, { method: 'POST' });
      this.assertStatus(response, calls, 'github pipeline failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readRunNotes(project: string, id: number): Promise<{ notes: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const repo = `${api}/repos/${repoPath(project)}`;
      const failure = 'github pipeline failed';
      const run = (await this.readJson(`${repo}/actions/runs/${id}`, headers, calls, undefined, failure)) as GithubRun;
      const suite = (await this.readJson(
        `${repo}/check-suites/${run.check_suite_id}/check-runs`,
        headers,
        calls,
        undefined,
        failure,
      )) as { check_runs?: { id?: number }[] };
      const notes: string[] = [];
      for (const checkRun of suite.check_runs ?? []) {
        const rows = await this.readJson(
          `${repo}/check-runs/${checkRun.id}/annotations`,
          headers,
          calls,
          undefined,
          failure,
        );
        for (const row of Array.isArray(rows) ? (rows as { message?: string }[]) : []) {
          if (row.message) {
            notes.push(row.message);
          }
        }
      }
      return { notes: (notes.length > 0 ? notes.join(' ') : (run.message ?? '')).trim(), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  private async failedJobs(
    api: string,
    headers: Record<string, string>,
    project: string,
    runId: number,
    calls: HttpCallDraft[],
  ): Promise<{ listed: PipelineJob[]; total: number }> {
    const response = await this.hostRequest(
      `${api}/repos/${project}/actions/runs/${runId}/jobs?per_page=100`,
      headers,
      calls,
    );
    this.assertStatus(response, calls, 'github pipeline failed');
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
    return {
      listed: jobs.flatMap((row) => asJob(row) ?? []),
      total: jobs.length,
    };
  }
}

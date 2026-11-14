import type { Clock } from '../../../core/clock';
import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import type { request } from '../../http';
import { withRetries } from '../../http';
import { githubRules } from './github-rules';
import { remoteProject } from '../remote-project';
import type { CodeHostEnv } from '../abstract-code-host';
import { GithubMergeRequests, repoPath } from './github-merge-requests';
import { snapshotOf } from '../check-status';
import { githubRepositories } from './github-repositories';
import { apiRoot, type GithubPull } from './github-pull';
import { asJob, awaitedChecks, checkStatus, listJobs, readChecks, runsOf, type GithubRun } from './github-checks';
import type {
  PipelineJob,
  PipelineRef,
  PipelineRun,
  PipelineSnapshot,
  PipelineDiagnosis,
  SelectedHost,
} from '../code-host';

/** A log archive that answered 403/404 from the redirect host: it may lag a job that just failed. */
class LogLagging extends Error {
  constructor(readonly response: Awaited<ReturnType<typeof request>>) {
    super(`HTTP ${response.status} for ${response.url}`);
  }
}

export class GithubCodeHost extends GithubMergeRequests {
  readonly name = githubRules.name;
  readonly label = githubRules.label;
  readonly ciFiles = githubRules.ciFiles;

  pushRejection(lines: string[]): string | undefined {
    return githubRules.pushRejection(lines);
  }

  classifyCall(url: string): string | null {
    return githubRules.classifyCall(url);
  }

  constructor(env: CodeHostEnv, clock: Clock) {
    super(env, clock, 'github pull request failed', 'GITHUB_TOKEN was rejected');
  }

  matchesOrigin(origin: string): boolean {
    return this.remoteOnBase(origin, this.env.GITHUB_BASE_URL) !== null;
  }

  pushUrl(origin: string): string | null {
    const token = this.env.GITHUB_TOKEN;
    if (!token.trim()) {
      return null;
    }
    try {
      const host = new URL(this.env.GITHUB_BASE_URL).hostname.toLowerCase();
      const remote = remoteProject(origin);
      if (remote.host.toLowerCase() !== host) {
        return null;
      }
      return `https://x-access-token:${encodeURIComponent(token)}@${host}/${remote.project}.git`;
    } catch {
      return null;
    }
  }

  cloneUrl(project: string): string {
    return `${this.env.GITHUB_BASE_URL.replace(/\/$/, '')}/${project}.git`;
  }

  selected(): SelectedHost {
    return {
      name: this.name,
      baseUrl: this.env.GITHUB_BASE_URL,
      token: this.env.GITHUB_TOKEN,
      baseKey: 'GITHUB_BASE_URL',
      tokenKey: 'GITHUB_TOKEN',
    };
  }

  async readBranchPipeline(
    ref: PipelineRef,
    jobs = true,
  ): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
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

  async diagnoseMissingPipeline(ref: PipelineRef): Promise<PipelineDiagnosis> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const owner = ref.project.split('/')[0] ?? '';
      const pulls = await this.readJson(
        `${root}/repos/${repoPath(ref.project)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${ref.ref}`)}&per_page=100`,
        headers,
        calls,
      );
      if (!Array.isArray(pulls)) {
        throw new SwarmloopError('github pipeline diagnosis failed');
      }
      const found = (pulls as GithubPull[]).find(
        (pull) => pull.head?.ref === ref.ref && (!ref.sha || pull.head.sha === ref.sha),
      );
      if (!found?.number) {
        return { reason: null, httpCalls: calls };
      }
      const pull = (await this.readJson(
        `${root}/repos/${repoPath(ref.project)}/pulls/${found.number}`,
        headers,
        calls,
      )) as GithubPull;
      const link = pull.html_url ?? `PR #${found.number}`;
      if (pull.head && (pull.head.ref !== ref.ref || (ref.sha && pull.head.sha !== ref.sha))) {
        return { reason: null, httpCalls: calls };
      }
      if (pull.state === 'closed') {
        return {
          reason: `${link} is closed; pull_request CI will not start for new pushes.`,
          code: 'closed',
          httpCalls: calls,
        };
      }
      if (pull.mergeable === false || pull.mergeable_state === 'dirty') {
        return {
          reason: `${link} has merge conflicts with its base branch; GitHub does not start pull_request CI until they are resolved. Rebase this run onto the latest base.`,
          code: ref.sha && pull.head?.sha === ref.sha && pull.state === 'open' ? 'merge-conflict' : undefined,
          httpCalls: calls,
        };
      }
      return { reason: null, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root: api, headers } = this.credentials();
      const url = `${api}/repos/${repoPath(project)}/actions/jobs/${jobId}/logs`;
      const apiHost = this.apiHost();
      const response = await withRetries(
        async () => {
          const result = await this.hostRequest(url, headers, calls);
          if ((result.status === 403 || result.status === 404) && new URL(result.url).hostname !== apiHost) {
            throw new LogLagging(result);
          }
          return result;
        },
        (error) => error instanceof LogLagging,
      ).catch((error: unknown) => {
        if (error instanceof LogLagging) {
          return error.response;
        }
        throw error;
      });
      this.assertStatus(response, calls, 'github pipeline failed');
      return { trace: response.body.toString('utf8'), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  protected credentialKeys(): readonly (keyof CodeHostEnv)[] {
    return ['GITHUB_BASE_URL', 'GITHUB_TOKEN'];
  }

  protected endpoint(env: CodeHostEnv): { root: string; headers: Record<string, string> } {
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

  protected readonly repositories = githubRepositories;

  protected userUrl(root: string): string {
    return `${root}/user`;
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

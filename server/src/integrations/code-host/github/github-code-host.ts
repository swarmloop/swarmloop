import type { Clock } from '../../../core/clock';
import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { request, withRetries } from '../../http';
import { remoteProject } from '../remote-project';
import { AbstractCodeHost, type CodeHostEnv } from '../abstract-code-host';
import { snapshotOf } from '../check-status';
import { awaitedChecks, checkStatus, readChecks, runsOf, type GithubRun } from './github-checks';
import type {
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
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

interface GithubPull {
  number?: number;
  html_url?: string;
  body?: string | null;
  head?: { ref?: string; sha?: string };
  state?: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
}

export class GithubCodeHost extends AbstractCodeHost {
  readonly name = 'github' as const;

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
        const listed = listJobs(status, jobs)
          ? await this.failedJobs(api, headers, project, run.id as number, calls)
          : [];
        const named =
          runs.length > 1 ? listed.map((job) => ({ ...job, name: `${run.name ?? 'workflow'} / ${job.name}` })) : listed;
        rows.push({ id: run.id as number, status, url: run.html_url ?? '', jobs: named });
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
      const response = await request(this.clock, url, headers, calls, { method: 'POST' });
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
      const response = await request(this.clock, url, headers, calls, { method: 'POST' });
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
          const result = await request(this.clock, url, headers, calls);
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

  protected userUrl(root: string): string {
    return `${root}/user`;
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

  protected updateRequest(
    root: string,
    project: string,
    iid: number,
    summary: string,
  ): { url: string; method: string; payload: string } {
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
    const row = (body as unknown[]).find((item) => (item as GithubPull | null)?.head?.ref === source);
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
    const response = await request(
      this.clock,
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
    return jobs.flatMap((row) => {
      const job = asJob(row);
      return job ? [job] : [];
    });
  }
}

function listJobs(status: string, jobs: boolean): boolean {
  if (status === 'running') {
    return jobs;
  }
  return status === 'success' || status === 'failed' || status === 'canceled';
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

function asJob(row: unknown): PipelineJob | null {
  const job = row as { id?: number; name?: string; conclusion?: string | null; status?: string } | null;
  if (!job?.id) {
    return null;
  }
  const done: Record<string, string> = {
    failure: 'failed',
    timed_out: 'timed_out',
    cancelled: 'canceled',
    startup_failure: 'startup_failure',
  };
  const finished = job.conclusion ? done[job.conclusion] : undefined;
  if (finished) {
    return { id: job.id, name: job.name ?? String(job.id), stage: '', status: finished, allowFailure: false };
  }
  if (job.status && job.status !== 'completed') {
    return { id: job.id, name: job.name ?? String(job.id), stage: '', status: job.status, allowFailure: false };
  }
  return null;
}

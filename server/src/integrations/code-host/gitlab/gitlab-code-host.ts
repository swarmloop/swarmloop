import type { Clock } from '../../../core/clock';
import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { gitlabRules } from './gitlab-rules';
import { remoteProject } from '../remote-project';
import { gitlabAuthor } from './gitlab-author';
import { gitlabRepositories } from './gitlab-repositories';
import { GitlabCi } from './gitlab-ci';
import type { GitlabMergeRequest } from './gitlab-merge-request';
import type { CodeHostEnv } from '../abstract-code-host';
import type { PipelineRef, PipelineDiagnosis, SelectedHost } from '../code-host';

export class GitlabCodeHost extends GitlabCi {
  readonly name = gitlabRules.name;
  readonly label = gitlabRules.label;

  pushRejection(lines: string[]): string | undefined {
    return gitlabRules.pushRejection(lines);
  }

  classifyCall(url: string): string | null {
    return gitlabRules.classifyCall(url);
  }

  /** `bearer` is true for the OAuth token of a connected person: GitLab takes it as a Bearer header, not as `PRIVATE-TOKEN`. */
  constructor(
    env: CodeHostEnv,
    clock: Clock,
    private readonly bearer = false,
  ) {
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

  async readAuthor(login: string): Promise<{ name: string | null; email: string | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const host = new URL(root).hostname.toLowerCase();
      const read = (url: string): Promise<unknown> => this.readJson(url, headers, calls);
      const own = (url: string): Promise<unknown> =>
        read(url).catch((error: unknown) => {
          if (error instanceof FetchFailed) return null;
          throw error;
        });
      const author = await gitlabAuthor(read, own, root, login, host);
      return { ...author, httpCalls: calls };
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
      headers: {
        ...(this.bearer ? { Authorization: `Bearer ${env.GITLAB_TOKEN}` } : { 'PRIVATE-TOKEN': env.GITLAB_TOKEN }),
        Accept: 'application/json',
      },
    };
  }

  protected readonly repositories = gitlabRepositories;

  protected userUrl(root: string): string {
    return `${root}/api/v4/user`;
  }

  private async readText(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    failure: string,
  ): Promise<string> {
    const response = await this.hostRequest(url, headers, calls);
    this.assertStatus(response, calls, failure);
    return response.body.toString('utf8');
  }
}

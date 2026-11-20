import type { RemoteRepository, RepositoryOwner } from '../../contract/api';
import type { Clock } from '../../core/clock';
import { FetchFailed, type HttpCallDraft } from '../../core/swarmloop-error';
import { AbstractMergeRequests } from './abstract-merge-requests';
import type { CodeHostEnv, HostCall } from './host-calls';
import { providerMessage } from './provider-message';
import type {
  CodeHost,
  CreateRepositoryDraft,
  MergeMethod,
  PipelineRef,
  RepositoryApi,
  PipelineSnapshot,
  PipelineDiagnosis,
  SelectedHost,
} from './code-host';

export type { CodeHostEnv, HostCall };

/** Rows per page of a repository list. A shorter page is the last one. */
const PAGE_SIZE = 100;

export abstract class AbstractCodeHost extends AbstractMergeRequests implements CodeHost {
  abstract readonly name: SelectedHost['name'];
  abstract readonly label: string;
  abstract readonly ciFiles: readonly string[];
  abstract pushRejection(lines: string[]): string | undefined;

  abstract diagnoseMissingPipeline(ref: PipelineRef): Promise<PipelineDiagnosis>;

  abstract startPipeline(ref: PipelineRef, reason: string): Promise<{ httpCalls: HttpCallDraft[] }>;

  abstract setDraft(project: string, iid: number, draft: boolean): Promise<{ httpCalls: HttpCallDraft[] }>;

  abstract readDefaultHead(project: string): Promise<{ branch: string; sha: string; httpCalls: HttpCallDraft[] }>;

  abstract readBranchHead(ref: PipelineRef): Promise<{ sha: string; httpCalls: HttpCallDraft[] }>;

  abstract readMergeMethods(project: string): Promise<{ methods: MergeMethod[]; httpCalls: HttpCallDraft[] }>;

  abstract readAuthor(
    login: string,
  ): Promise<{ name: string | null; email: string | null; httpCalls: HttpCallDraft[] }>;

  async deleteBranch(project: string, branch: string): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const response = await this.send(this.deleteCall(root, project, branch), headers, calls);
      if (response.status !== 404 && response.status !== 422) {
        this.assertStatus(response, calls, this.failure);
      }
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readCurrentUser(): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      await this.readJson(this.userUrl(root), headers, calls);
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async listRepositories(
    page: number,
  ): Promise<{ repositories: RemoteRepository[]; more: boolean; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const rows = await this.hostJson(this.repositories.listUrl(root, page, PAGE_SIZE), headers, calls);
      if (!Array.isArray(rows)) {
        throw new FetchFailed('repository list failed', calls);
      }
      const repositories = (rows as unknown[]).flatMap((row) => this.repositories.repositoryOf(row) ?? []);
      return { repositories, more: rows.length >= PAGE_SIZE, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async listOwners(): Promise<{ owners: RepositoryOwner[]; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const owners = await this.repositories.readOwners(root, (url) => this.hostJson(url, headers, calls));
      return { owners, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async createRepository(
    draft: CreateRepositoryDraft,
  ): Promise<{ repository: RemoteRepository; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const { url, payload } = this.repositories.createRequest(root, draft);
      const body = await this.hostJson(url, { ...headers, 'Content-Type': 'application/json' }, calls, payload);
      const repository = this.repositories.repositoryOf(body);
      if (!repository) {
        throw new FetchFailed('repository create failed', calls);
      }
      return { repository, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  cloneEnv(): NodeJS.ProcessEnv {
    const basic = Buffer.from(`${this.repositories.gitUser}:${this.selected().token}`).toString('base64');
    return {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  }

  abstract cloneUrl(project: string): string;

  abstract readBranchPipeline(
    ref: PipelineRef,
    jobs?: boolean,
  ): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }>;

  abstract readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }>;

  abstract cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }>;

  abstract rerunFailedJobs(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }>;

  abstract readRunNotes(project: string, id: number): Promise<{ notes: string; httpCalls: HttpCallDraft[] }>;

  abstract matchesOrigin(origin: string): boolean;

  abstract pushUrl(origin: string): string | null;

  abstract selected(): SelectedHost;

  secrets(): string[] {
    return [this.selected().token].filter(Boolean);
  }

  /** The same host calling with another token: the OAuth token of the person a run belongs to. */
  withToken(token: string): this {
    const Host = this.constructor as new (env: CodeHostEnv, clock: Clock, connected: boolean) => this;
    return new Host({ ...this.env, [this.selected().tokenKey]: token }, this.clock, true);
  }

  protected abstract userUrl(root: string): string;

  protected abstract readonly repositories: RepositoryApi;

  protected abstract deleteCall(root: string, project: string, branch: string): HostCall;

  /** A JSON read or POST whose refusal carries the host's message, and the permission needed when the token is rejected. */
  private async hostJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
  ): Promise<unknown> {
    const response = await this.hostRequest(url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    if (response.status < 200 || response.status >= 300) {
      const message = providerMessage(response.body) || `repository request failed: HTTP ${response.status}`;
      const rejected = response.status === 401 || response.status === 403;
      throw new FetchFailed(rejected ? `${message} (needs ${this.repositories.needs})` : message, calls);
    }
    return this.parse(response.body, calls);
  }
}

import type { RemoteRepository, RepositoryOwner } from '../../contract/api';
import type { SwarmloopEnv } from '../../config/env';
import type { Clock } from '../../core/clock';
import type { HttpCallDraft } from '../../core/swarmloop-error';
import { FetchFailed, MergeConflict, SwarmloopError } from '../../core/swarmloop-error';
import { request } from '../http';
import { remoteProject } from '../../integrations/code-host/remote-project';
import type {
  CodeHost,
  CreateRepositoryDraft,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  MergeRequestView,
  PipelineRef,
  PipelineSnapshot,
  SelectedHost,
} from './code-host';

/** What a host says about its repositories: its urls and payloads, and who the token is in a Basic header. */
export interface RepositoryApi {
  /** The user name of the token in a Basic header, the same one `pushUrl` uses. */
  gitUser: string;
  /** The permission a token needs to list, create and clone, named in a refusal. */
  needs: string;
  listUrl(root: string, page: number, perPage: number): string;
  /** The repository of one row, or null when the token cannot push to it. */
  repositoryOf(row: unknown): RemoteRepository | null;
  readOwners(root: string, read: (url: string) => Promise<unknown>): Promise<RepositoryOwner[]>;
  createRequest(root: string, draft: CreateRepositoryDraft): { url: string; payload: string };
}

/** Rows per page of a repository list. A shorter page is the last one. */
const PAGE_SIZE = 100;

/** The env keys a code host reads. */
export type CodeHostEnv = Pick<SwarmloopEnv, 'GITHUB_BASE_URL' | 'GITHUB_TOKEN' | 'GITLAB_BASE_URL' | 'GITLAB_TOKEN'>;

/** One call of a host's API. */
export interface HostCall {
  url: string;
  method: string;
  payload?: string;
}

export abstract class AbstractCodeHost implements CodeHost {
  abstract readonly name: SelectedHost['name'];

  constructor(
    protected readonly env: CodeHostEnv,
    protected readonly clock: Clock,
    private readonly failure: string,
    private readonly rejectedToken: string,
  ) {}

  async findMergeRequest(
    query: MergeRequestQuery,
  ): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const url = this.findUrl(root, query);
      const body = await this.readJson(url, headers, calls);
      const row = this.match(body, query.source);
      return { record: row ? this.record(query.project, row) : null, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async openMergeRequest(
    draft: MergeRequestDraft,
  ): Promise<{ record: MergeRequestRecord; draftsUnavailable: boolean; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const create = (asked: MergeRequestDraft): Promise<unknown> => {
        const { url, payload } = this.openRequest(root, asked);
        return this.readJson(url, { ...headers, 'Content-Type': 'application/json' }, calls, payload);
      };
      let body: unknown;
      let refused = false;
      try {
        body = await create(draft);
      } catch (error) {
        const reused = await this.reuse(draft, error, calls);
        if (reused) {
          return { ...reused, draftsUnavailable: false };
        }
        if (!draft.draft || !(error instanceof FetchFailed)) {
          throw error;
        }
        refused = true;
        body = await create({ ...draft, draft: false });
      }
      const record = this.record(draft.project, body, draft.summary);
      return { record, draftsUnavailable: draft.draft && (refused || !record.draft), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async updateMergeRequest(project: string, iid: number, summary: string): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const { url, method, payload } = this.updateRequest(root, project, iid, summary);
      const response = await request(this.clock, url, { ...headers, 'Content-Type': 'application/json' }, calls, {
        method,
        body: payload,
      });
      this.assertStatus(response, calls, this.failure);
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  abstract setDraft(project: string, iid: number, draft: boolean): Promise<{ httpCalls: HttpCallDraft[] }>;

  async readMergeRequest(project: string, iid: number): Promise<MergeRequestView & { httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const body = await this.readJson(this.mergeRequestUrl(root, project, iid), headers, calls);
      return { ...this.view(body), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async mergeMergeRequest(project: string, iid: number): Promise<{ sha: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const response = await this.send(this.mergeCall(root, project, iid), headers, calls);
      if (response.status < 200 || response.status >= 300) {
        throw this.refusal(response, calls);
      }
      const sha = this.mergedSha(this.parse(response.body, calls));
      if (!sha) {
        throw new FetchFailed(this.failure, calls);
      }
      return { sha, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async closeMergeRequest(project: string, iid: number): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const current = this.view(await this.readJson(this.mergeRequestUrl(root, project, iid), headers, calls));
      if (current.state === 'open') {
        this.assertStatus(await this.send(this.closeCall(root, project, iid), headers, calls), calls, this.failure);
      }
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

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

  /** The same host calling with another token: the OAuth token of the person a run belongs to. */
  withToken(token: string): this {
    const Host = this.constructor as new (env: CodeHostEnv, clock: Clock, connected: boolean) => this;
    return new Host({ ...this.env, [this.selected().tokenKey]: token }, this.clock, true);
  }

  protected credentials(): { root: string; headers: Record<string, string> } {
    const missing = this.credentialKeys().find((name) => !this.env[name]);
    if (missing) {
      throw new SwarmloopError(`${missing} is missing`);
    }
    return this.endpoint(this.env);
  }

  protected abstract credentialKeys(): readonly (keyof CodeHostEnv)[];

  protected abstract endpoint(env: CodeHostEnv): { root: string; headers: Record<string, string> };

  protected abstract userUrl(root: string): string;

  protected abstract readonly repositories: RepositoryApi;

  protected abstract findUrl(root: string, query: MergeRequestQuery): string;

  protected abstract openRequest(root: string, draft: MergeRequestDraft): { url: string; payload: string };

  protected abstract updateRequest(
    root: string,
    project: string,
    iid: number,
    summary: string,
  ): { url: string; method: string; payload: string };

  protected abstract mergeRequestUrl(root: string, project: string, iid: number): string;

  /** The squash merge of a request, into the target branch the request already has. */
  protected abstract mergeCall(root: string, project: string, iid: number): HostCall;

  protected abstract closeCall(root: string, project: string, iid: number): HostCall;

  protected abstract deleteCall(root: string, project: string, branch: string): HostCall;

  protected abstract view(body: unknown): MergeRequestView;

  protected abstract mergedSha(body: unknown): string | null;

  /** True when a refused merge says the branch conflicts with its target. */
  protected abstract mergeConflicts(status: number, message: string): boolean;

  protected abstract match(body: unknown, source: string): unknown;

  protected abstract record(project: string, row: unknown, summary?: string): MergeRequestRecord;

  protected abstract conflict(error: unknown, calls: HttpCallDraft[]): boolean;

  protected async readJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
    failure = this.failure,
  ): Promise<unknown> {
    const response = await request(this.clock, url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    this.assertStatus(response, calls, failure);
    try {
      return JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(failure, calls);
    }
  }

  /** A JSON read or POST whose refusal carries the host's message, and the permission needed when the token is rejected. */
  private async hostJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
  ): Promise<unknown> {
    const response = await request(this.clock, url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    if (response.status < 200 || response.status >= 300) {
      const message = providerMessage(response.body) || `repository request failed: HTTP ${response.status}`;
      const rejected = response.status === 401 || response.status === 403;
      throw new FetchFailed(rejected ? `${message} (needs ${this.repositories.needs})` : message, calls);
    }
    return this.parse(response.body, calls);
  }

  /** The refusal of a merge, with the host's own message. */
  protected refusal(response: { status: number; body: Buffer }, calls: HttpCallDraft[]): FetchFailed {
    const message = providerMessage(response.body) || `${this.failure}: HTTP ${response.status}`;
    return this.mergeConflicts(response.status, message)
      ? new MergeConflict(message, calls)
      : new FetchFailed(message, calls);
  }

  protected parse(body: Buffer, calls: HttpCallDraft[]): unknown {
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(this.failure, calls);
    }
  }

  private send(call: HostCall, headers: Record<string, string>, calls: HttpCallDraft[]): ReturnType<typeof request> {
    return request(this.clock, call.url, { ...headers, 'Content-Type': 'application/json' }, calls, {
      method: call.method,
      body: call.payload,
    });
  }

  protected remoteOnBase(origin: string, baseUrl: string): { host: string; project: string } | null {
    try {
      const remote = remoteProject(origin);
      const host = configuredHost(baseUrl);
      if (!host || remote.host.toLowerCase() !== host) {
        return null;
      }
      return { host, project: remote.project };
    } catch {
      return null;
    }
  }

  protected apiHost(): string {
    return new URL(this.endpoint(this.env).root).hostname;
  }

  protected assertStatus(response: { status: number; url: string }, calls: HttpCallDraft[], failure: string): void {
    const { status } = response;
    if (status === 401 || status === 403) {
      const host = new URL(response.url).hostname;
      throw new FetchFailed(
        host === this.apiHost() ? this.rejectedToken : `job log unavailable: HTTP ${status} from ${host}`,
        calls,
      );
    }
    if (status < 200 || status >= 300) {
      throw new FetchFailed(`${failure}: HTTP ${status}`, calls);
    }
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
      return {
        record: { ...found.record, summary: draft.summary },
        httpCalls: [...calls, ...found.httpCalls, ...updated.httpCalls],
      };
    } catch (foundError) {
      if (foundError instanceof FetchFailed) {
        throw new FetchFailed(foundError.message, [...calls, ...foundError.httpCalls]);
      }
      throw foundError;
    }
  }

  protected rethrow(error: unknown, calls: HttpCallDraft[]): never {
    if (error instanceof FetchFailed) {
      throw error;
    }
    const message = error instanceof Error ? error.message : this.failure;
    if (error instanceof SwarmloopError && calls.length === 0) {
      throw error;
    }
    throw new FetchFailed(message, calls);
  }
}

/** The `message` or `error` text of a host's JSON answer. */
function providerMessage(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown; error?: unknown } | null;
    const text = parsed?.message ?? parsed?.error;
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

function configuredHost(base: string): string | null {
  const trimmed = base.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

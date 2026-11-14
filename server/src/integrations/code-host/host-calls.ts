import type { SwarmloopEnv } from '../../config/env';
import type { Clock } from '../../core/clock';
import { FetchFailed, HostUnavailable, SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { request } from '../http';
import { configuredHost } from './provider-message';
import { remoteProject } from './remote-project';

/** The env keys a code host reads. */
export type CodeHostEnv = Pick<SwarmloopEnv, 'GITHUB_BASE_URL' | 'GITHUB_TOKEN' | 'GITLAB_BASE_URL' | 'GITLAB_TOKEN'>;

/** One call of a host's API. */
export interface HostCall {
  url: string;
  method: string;
  payload?: string;
}

/** The HTTP plumbing every code host shares: credentials, calls, status checks and error mapping. */
export abstract class HostCalls {
  constructor(
    protected readonly env: CodeHostEnv,
    protected readonly clock: Clock,
    protected readonly failure: string,
    private readonly rejectedToken: string,
  ) {}

  /** The provider label this host gives a call of its own API, or null for a url that is not its API. */
  abstract classifyCall(url: string): string | null;

  protected credentials(): { root: string; headers: Record<string, string> } {
    const missing = this.credentialKeys().find((name) => !this.env[name]);
    if (missing) {
      throw new SwarmloopError(`${missing} is missing`);
    }
    return this.endpoint(this.env);
  }

  protected abstract credentialKeys(): readonly (keyof CodeHostEnv)[];

  protected abstract endpoint(env: CodeHostEnv): { root: string; headers: Record<string, string> };

  protected hostRequest(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    init: { method?: string; body?: string } = {},
  ): ReturnType<typeof request> {
    return request(this.clock, url, headers, calls, { ...init, classify: (at) => this.classifyCall(at) });
  }

  protected async readJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
    failure = this.failure,
  ): Promise<unknown> {
    const response = await this.hostRequest(url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    this.assertStatus(response, calls, failure);
    try {
      return JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(failure, calls);
    }
  }

  protected parse(body: Buffer, calls: HttpCallDraft[]): unknown {
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(this.failure, calls);
    }
  }

  protected send(call: HostCall, headers: Record<string, string>, calls: HttpCallDraft[]): ReturnType<typeof request> {
    return this.hostRequest(call.url, { ...headers, 'Content-Type': 'application/json' }, calls, {
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

  protected rethrow(error: unknown, calls: HttpCallDraft[]): never {
    if (error instanceof FetchFailed || error instanceof HostUnavailable) {
      throw error;
    }
    const message = error instanceof Error ? error.message : this.failure;
    if (error instanceof SwarmloopError && calls.length === 0) {
      throw error;
    }
    throw new FetchFailed(message, calls);
  }
}

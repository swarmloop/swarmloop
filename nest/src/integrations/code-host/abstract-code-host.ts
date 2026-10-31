import { ConfigService } from '@nestjs/config';
import { readEnv, SwarmloopEnv } from '../../config/env';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../swarmloop-error';
import { request } from '../../providers/http';
import { CodeHost, MergeRequestDraft, MergeRequestQuery, MergeRequestRecord, PipelineRef, PipelineSnapshot } from './code-host';

export abstract class AbstractCodeHost implements CodeHost {
  constructor(
    protected readonly config: ConfigService,
    private readonly failure: string,
    private readonly rejectedToken: string,
  ) {}

  async findMergeRequest(query: MergeRequestQuery): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }> {
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

  async openMergeRequest(draft: MergeRequestDraft): Promise<{ record: MergeRequestRecord; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const { url, payload } = this.openRequest(root, draft);
      const body = await this.readJson(url, { ...headers, 'Content-Type': 'application/json' }, calls, payload);
      return { record: this.record(draft.project, body, draft.summary), httpCalls: calls };
    } catch (error) {
      const reused = await this.reuse(draft, error, calls);
      if (reused) {
        return reused;
      }
      this.rethrow(error, calls);
    }
  }

  async updateMergeRequest(project: string, iid: number, summary: string): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const { url, method, payload } = this.updateRequest(root, project, iid, summary);
      const response = await request(url, { ...headers, 'Content-Type': 'application/json' }, calls, { method, body: payload });
      this.assertStatus(response.status, calls, this.failure);
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  abstract readBranchPipeline(ref: PipelineRef): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }>;

  abstract readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }>;

  abstract cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }>;

  protected credentials(): { root: string; headers: Record<string, string> } {
    const env = readEnv(this.config);
    const missing = this.credentialKeys().find((name) => !env[name]);
    if (missing) {
      throw new SwarmloopError(`${missing} is missing`);
    }
    return this.endpoint(env);
  }

  protected abstract credentialKeys(): readonly (keyof SwarmloopEnv)[];

  protected abstract endpoint(env: SwarmloopEnv): { root: string; headers: Record<string, string> };

  protected abstract findUrl(root: string, query: MergeRequestQuery): string;

  protected abstract openRequest(root: string, draft: MergeRequestDraft): { url: string; payload: string };

  protected abstract updateRequest(
    root: string,
    project: string,
    iid: number,
    summary: string,
  ): { url: string; method: string; payload: string };

  protected abstract match(body: unknown, source: string): unknown | null;

  protected abstract record(project: string, row: unknown, summary?: string): MergeRequestRecord;

  protected abstract conflict(error: unknown, calls: HttpCallDraft[]): boolean;

  protected async readJson(
    url: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    body?: string,
    failure = this.failure,
  ): Promise<unknown> {
    const response = await request(url, headers, calls, body === undefined ? {} : { method: 'POST', body });
    this.assertStatus(response.status, calls, failure);
    try {
      return JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new FetchFailed(failure, calls);
    }
  }

  protected assertStatus(status: number, calls: HttpCallDraft[], failure: string): void {
    if (status === 401 || status === 403) {
      throw new FetchFailed(this.rejectedToken, calls);
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
      return { record: { ...found.record, summary: draft.summary }, httpCalls: [...calls, ...found.httpCalls, ...updated.httpCalls] };
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

import type { HttpCallDraft } from '../../core/swarmloop-error';
import { GitRuleRefused } from '../../core/git-rule-refused';
import { FetchFailed, MergeConflict, NothingToMerge } from '../../core/swarmloop-error';
import { HostCalls, type HostCall } from './host-calls';
import { providerMessage } from './provider-message';
import { requestState } from './request-state';
import type {
  MergeGate,
  MergeHow,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  MergeRequestState,
  MergeRequestView,
  RequestStateApi,
} from './code-host';

/** The merge-request half of every code host: find, open, update, read, gate, state, merge and close, over the hooks an adapter gives. */
export abstract class AbstractMergeRequests extends HostCalls {
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
      const create = async (asked: MergeRequestDraft): Promise<unknown> => {
        const { url, payload } = this.openRequest(root, asked);
        const response = await this.hostRequest(url, { ...headers, 'Content-Type': 'application/json' }, calls, {
          method: 'POST',
          body: payload,
        });
        if (response.status === 401 || response.status === 403) {
          this.assertStatus(response, calls, this.failure);
        }
        if (response.status < 200 || response.status >= 300) {
          throw this.openRefusal(response, calls, asked.title);
        }
        return this.parse(response.body, calls);
      };
      let body: unknown;
      let refused = false;
      try {
        body = await create(draft);
      } catch (error) {
        if (error instanceof NothingToMerge) {
          throw error;
        }
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
      const response = await this.hostRequest(url, { ...headers, 'Content-Type': 'application/json' }, calls, {
        method,
        body: payload,
      });
      this.assertStatus(response, calls, this.failure);
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

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

  async readMergeGate(project: string, iid: number): Promise<MergeGate & { httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const body = await this.readJson(this.mergeRequestUrl(root, project, iid), headers, calls);
      return { ...this.gate(body), httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async mergeRequestState(project: string, iid: number): Promise<MergeRequestState & { httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const url = this.mergeRequestUrl(root, project, iid);
      const state = await requestState(this.states, url, this.clock.iso(), (at) => this.readJson(at, headers, calls));
      return { ...state, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async mergeMergeRequest(
    project: string,
    iid: number,
    head?: string,
    how?: MergeHow,
  ): Promise<{ sha: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const response = await this.send(this.mergeCall(root, project, iid, head, how), headers, calls);
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

  protected abstract findUrl(root: string, query: MergeRequestQuery): string;

  protected abstract openRequest(root: string, draft: MergeRequestDraft): { url: string; payload: string };

  protected abstract updateRequest(root: string, project: string, iid: number, summary: string): Required<HostCall>;

  protected abstract mergeRequestUrl(root: string, project: string, iid: number): string;

  /** The merge of a request, into the target branch the request already has: a squash without `how`. A given `head` is sent as `sha`, the merge guard. */
  protected abstract mergeCall(root: string, project: string, iid: number, head?: string, how?: MergeHow): HostCall;

  /** True when a refused open says a rule of the repository refuses the title. */
  protected abstract titleRefused(status: number, message: string): boolean;

  protected abstract closeCall(root: string, project: string, iid: number): HostCall;

  protected abstract view(body: unknown): MergeRequestView;

  protected abstract gate(body: unknown): MergeGate;

  protected abstract readonly states: RequestStateApi;

  protected abstract mergedSha(body: unknown): string | null;

  /** True when a refused merge says the branch conflicts with its target. */
  protected abstract mergeConflicts(status: number, message: string): boolean;

  protected abstract match(body: unknown, source: string): unknown;

  protected abstract record(project: string, row: unknown, summary?: string): MergeRequestRecord;

  protected abstract conflict(error: unknown, calls: HttpCallDraft[]): boolean;

  /** The refusal of a merge, with the host's own message. */
  protected refusal(response: { status: number; body: Buffer }, calls: HttpCallDraft[]): FetchFailed {
    const message = providerMessage(response.body) || `${this.failure}: HTTP ${response.status}`;
    return this.mergeConflicts(response.status, message)
      ? new MergeConflict(message, calls)
      : new FetchFailed(message, calls);
  }

  /**
   * The refusal of an open request: a 422 with a message from the host says it in the host's words, and a message
   * that a rule refuses the title makes it a `GitRuleRefused` of that title.
   */
  protected openRefusal(
    response: { status: number; body: Buffer },
    calls: HttpCallDraft[],
    title: string,
  ): FetchFailed | GitRuleRefused {
    const said = providerMessage(response.body);
    if (said && this.titleRefused(response.status, said)) {
      return new GitRuleRefused(said, title, 'title');
    }
    const message = response.status === 422 ? said : '';
    return new FetchFailed(message || `${this.failure}: HTTP ${response.status}`, calls);
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
}

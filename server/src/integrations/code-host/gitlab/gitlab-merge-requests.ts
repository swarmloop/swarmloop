import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractCodeHost, type HostCall } from '../abstract-code-host';
import { gitlabStates, mergeRequestMergeability, type GitlabMergeRequest } from './gitlab-merge-request';
import type {
  MergeGate,
  MergeHow,
  MergeMethod,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  MergeRequestView,
  PipelineRef,
} from '../code-host';

/** GitLab's own draft marker: a title that starts with it. */
const DRAFT_PREFIX = 'Draft: ';

function isDraft(merge: GitlabMergeRequest): boolean {
  return merge.draft === true || (merge.title ?? '').startsWith(DRAFT_PREFIX);
}

/** The merge-request half of the GitLab adapter: its urls, payloads and states. */
export abstract class GitlabMergeRequests extends AbstractCodeHost {
  async setDraft(project: string, iid: number, draft: boolean): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const url = this.mergeRequestUrl(root, project, iid);
      const merge = (await this.readJson(url, headers, calls)) as GitlabMergeRequest;
      if (isDraft(merge) === draft) {
        return { httpCalls: calls };
      }
      const bare = (merge.title ?? '').replace(/^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i, '');
      const response = await this.hostRequest(url, { ...headers, 'Content-Type': 'application/json' }, calls, {
        method: 'PUT',
        body: JSON.stringify({ title: draft ? `${DRAFT_PREFIX}${bare}` : bare }),
      });
      this.assertStatus(response, calls, 'gitlab merge request failed');
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  /** Creates the pipeline of the merge request of the ref, the way a late event would have, and notes the reason on it. */
  async startPipeline(ref: PipelineRef, reason: string): Promise<{ httpCalls: HttpCallDraft[] }> {
    const found = await this.findMergeRequest({ project: ref.project, source: ref.ref });
    const calls = [...found.httpCalls];
    if (!found.record) {
      return { httpCalls: calls };
    }
    try {
      const { root, headers } = this.credentials();
      const base = this.mergeRequestUrl(root, ref.project, found.record.iid);
      this.assertStatus(
        await this.hostRequest(`${base}/notes`, { ...headers, 'Content-Type': 'application/json' }, calls, {
          method: 'POST',
          body: JSON.stringify({ body: reason }),
        }),
        calls,
        this.failure,
      );
      this.assertStatus(
        await this.hostRequest(`${base}/pipelines`, headers, calls, { method: 'POST' }),
        calls,
        this.failure,
      );
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  protected findUrl(root: string, query: MergeRequestQuery): string {
    return `${root}/api/v4/projects/${encodeURIComponent(query.project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(query.source)}`;
  }

  protected openRequest(root: string, draft: MergeRequestDraft): { url: string; payload: string } {
    return {
      url: `${root}/api/v4/projects/${encodeURIComponent(draft.project)}/merge_requests`,
      payload: JSON.stringify({
        source_branch: draft.source,
        target_branch: draft.target,
        title: (draft.draft ? `${DRAFT_PREFIX}${draft.title}` : draft.title).slice(0, 255),
        description: draft.summary,
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
      url: `${root}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
      method: 'PUT',
      payload: JSON.stringify({ description: summary }),
    };
  }

  protected mergeRequestUrl(root: string, project: string, iid: number): string {
    return `${root}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
  }

  protected mergeCall(root: string, project: string, iid: number, head?: string, how?: MergeHow): HostCall {
    const message = how?.title;
    const way =
      how === undefined || how.method === 'squash'
        ? { squash: true, ...(message ? { squash_commit_message: message } : {}) }
        : message
          ? { merge_commit_message: message }
          : {};
    return {
      url: `${this.mergeRequestUrl(root, project, iid)}/merge`,
      method: 'PUT',
      payload: JSON.stringify({ ...way, ...(head ? { sha: head } : {}) }),
    };
  }

  /**
   * The project's `merge_method` (merge commit, merge commit over a rebase, or fast-forward only) and `squash_option`,
   * as the methods a merge request may use.
   */
  async readMergeMethods(project: string): Promise<{ methods: MergeMethod[]; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const settings = (await this.readJson(
        `${root}/api/v4/projects/${encodeURIComponent(project)}`,
        headers,
        calls,
      )) as { merge_method?: string; squash_option?: string } | null;
      const way = settings?.merge_method;
      const squash = settings?.squash_option;
      const methods: MergeMethod[] = [];
      if (squash !== 'never') {
        methods.push('squash');
      }
      if (squash !== 'always' && (way === 'rebase_merge' || way === 'ff')) {
        methods.push('rebase');
      }
      if (squash !== 'always' && (way === 'merge' || way === 'rebase_merge')) {
        methods.push('merge');
      }
      return { methods, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readDefaultHead(project: string): Promise<{ branch: string; sha: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const base = `${root}/api/v4/projects/${encodeURIComponent(project)}`;
      const repository = (await this.readJson(base, headers, calls)) as { default_branch?: string } | null;
      const branch = repository?.default_branch;
      if (!branch) {
        throw new FetchFailed(this.failure, calls);
      }
      const sha = await this.readTip(base, branch, headers, calls);
      return { branch, sha, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  async readBranchHead(ref: PipelineRef): Promise<{ sha: string; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const base = `${root}/api/v4/projects/${encodeURIComponent(ref.project)}`;
      const sha = await this.readTip(base, ref.ref, headers, calls);
      return { sha, httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  private async readTip(
    base: string,
    branch: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
  ): Promise<string> {
    const url = `${base}/repository/branches/${encodeURIComponent(branch)}`;
    const tip = (await this.readJson(url, headers, calls)) as { commit?: { id?: string } } | null;
    if (!tip?.commit?.id) {
      throw new FetchFailed(this.failure, calls);
    }
    return tip.commit.id;
  }

  protected closeCall(root: string, project: string, iid: number): HostCall {
    return {
      url: this.mergeRequestUrl(root, project, iid),
      method: 'PUT',
      payload: JSON.stringify({ state_event: 'close' }),
    };
  }

  protected deleteCall(root: string, project: string, branch: string): HostCall {
    return {
      url: `${root}/api/v4/projects/${encodeURIComponent(project)}/repository/branches/${encodeURIComponent(branch)}`,
      method: 'DELETE',
    };
  }

  protected view(body: unknown): MergeRequestView {
    const merge = (body ?? {}) as GitlabMergeRequest;
    const merged = merge.state === 'merged';
    return {
      state: merged ? 'merged' : merge.state === 'closed' ? 'closed' : 'open',
      sha: merged ? this.mergedSha(merge) : null,
      conflicts: merge.has_conflicts === true || merge.detailed_merge_status === 'conflict',
      draft: isDraft(merge),
    };
  }

  protected gate(body: unknown): MergeGate {
    const { state, sha, draft } = this.view(body);
    const merge = (body ?? {}) as GitlabMergeRequest;
    return {
      state,
      sha,
      draft: draft || merge.work_in_progress === true,
      head: merge.sha ?? '',
      ...mergeRequestMergeability(merge.detailed_merge_status),
    };
  }

  protected readonly states = gitlabStates;

  protected mergedSha(body: unknown): string | null {
    const merge = (body ?? {}) as GitlabMergeRequest;
    return merge.merge_commit_sha ?? merge.squash_commit_sha ?? merge.sha ?? null;
  }

  protected mergeConflicts(status: number, message: string): boolean {
    return (status === 405 || status === 406) && /conflict|cannot be merged/i.test(message);
  }

  protected match(body: unknown, source: string): GitlabMergeRequest | null {
    if (!Array.isArray(body)) {
      throw new SwarmloopError('gitlab merge request failed');
    }
    const row = (body as unknown[]).find((item) => (item as GitlabMergeRequest | null)?.source_branch === source);
    return (row as GitlabMergeRequest | undefined) ?? null;
  }

  protected record(project: string, row: unknown, summary?: string): MergeRequestRecord {
    const merge = row as GitlabMergeRequest;
    const text = summary ?? merge.description ?? '';
    if (!merge.iid || !merge.web_url) {
      throw new SwarmloopError('gitlab merge request failed');
    }
    return { project, iid: merge.iid, url: merge.web_url, summary: text, draft: isDraft(merge) };
  }

  /** A 400 or 422 whose text says a rule of the project refuses the title. */
  protected titleRefused(status: number, message: string): boolean {
    return (
      (status === 400 || status === 422) &&
      /title/i.test(message) &&
      /rule|pattern|match|format|convention/i.test(message)
    );
  }

  protected conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 409);
  }
}

import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractCodeHost, type HostCall } from '../abstract-code-host';
import { githubStates, graphqlUrl, pullView, type GithubPull } from './github-pull';
import { request } from '../../http';
import type {
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  MergeRequestView,
  PipelineRef,
} from '../code-host';

/** The merge-request half of the GitHub adapter: its pull request urls, payloads and states. */
export abstract class GithubMergeRequests extends AbstractCodeHost {
  /** The REST API cannot change the draft state of a pull request, so this is a GraphQL mutation on its node id. */
  async setDraft(project: string, iid: number, draft: boolean): Promise<{ httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const pull = (await this.readJson(this.mergeRequestUrl(root, project, iid), headers, calls)) as GithubPull;
      if ((pull.draft === true) === draft) {
        return { httpCalls: calls };
      }
      if (!pull.node_id) {
        throw new FetchFailed('github pull request failed', calls);
      }
      const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
      const query = `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { id } } }`;
      const answer = (await this.readJson(
        graphqlUrl(root),
        { ...headers, 'Content-Type': 'application/json' },
        calls,
        JSON.stringify({ query, variables: { id: pull.node_id } }),
      )) as { errors?: { message?: string }[] } | null;
      if (answer?.errors?.length) {
        throw new FetchFailed(answer.errors[0]?.message || 'github pull request failed', calls);
      }
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
  }

  /** The event a `pull_request` workflow listens to besides a push: the pull request is closed and reopened, and a draft stays a draft. */
  async startPipeline(ref: PipelineRef): Promise<{ httpCalls: HttpCallDraft[] }> {
    const found = await this.findMergeRequest({ project: ref.project, source: ref.ref });
    const calls = [...found.httpCalls];
    if (!found.record) {
      return { httpCalls: calls };
    }
    try {
      const { root, headers } = this.credentials();
      const url = this.mergeRequestUrl(root, ref.project, found.record.iid);
      for (const state of ['closed', 'open']) {
        const response = await request(this.clock, url, { ...headers, 'Content-Type': 'application/json' }, calls, {
          method: 'PATCH',
          body: JSON.stringify({ state }),
        });
        this.assertStatus(response, calls, this.failure);
      }
      calls.push(...(await this.setDraft(ref.project, found.record.iid, found.record.draft)).httpCalls);
      return { httpCalls: calls };
    } catch (error) {
      this.rethrow(error, calls);
    }
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
        draft: draft.draft,
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

  protected mergeRequestUrl(root: string, project: string, iid: number): string {
    return `${root}/repos/${repoPath(project)}/pulls/${iid}`;
  }

  protected mergeCall(root: string, project: string, iid: number): HostCall {
    return {
      url: `${this.mergeRequestUrl(root, project, iid)}/merge`,
      method: 'PUT',
      payload: JSON.stringify({ merge_method: 'squash' }),
    };
  }

  protected closeCall(root: string, project: string, iid: number): HostCall {
    return {
      url: this.mergeRequestUrl(root, project, iid),
      method: 'PATCH',
      payload: JSON.stringify({ state: 'closed' }),
    };
  }

  protected deleteCall(root: string, project: string, branch: string): HostCall {
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    return { url: `${root}/repos/${repoPath(project)}/git/refs/heads/${ref}`, method: 'DELETE' };
  }

  protected view(body: unknown): MergeRequestView {
    return pullView(body);
  }

  protected readonly states = githubStates;

  protected mergedSha(body: unknown): string | null {
    return (body as { sha?: string } | null)?.sha ?? null;
  }

  protected mergeConflicts(status: number, message: string): boolean {
    return (status === 405 || status === 409) && /not mergeable|conflict/i.test(message);
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
    return { project, iid: pull.number, url: pull.html_url, summary: text, draft: pull.draft === true };
  }

  protected conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 422 || call.statusCode === 409);
  }
}

export function repoPath(project: string): string {
  return project
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

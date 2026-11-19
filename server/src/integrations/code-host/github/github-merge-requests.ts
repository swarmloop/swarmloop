import type { HttpCallDraft } from '../../../core/swarmloop-error';
import { GitRuleRefused } from '../../../core/git-rule-refused';
import { FetchFailed, NothingToMerge, SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractCodeHost, type HostCall } from '../abstract-code-host';
import { providerMessage } from '../provider-message';
import { githubStates, graphqlUrl, pullMergeability, pullView, type GithubPull } from './github-pull';
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

  /**
   * The event a `pull_request` workflow listens to besides a push: the pull request is closed and reopened, and a draft
   * stays a draft. The reason is a comment on the pull request, written first so it reads before the close and reopen.
   */
  async startPipeline(ref: PipelineRef, reason: string): Promise<{ httpCalls: HttpCallDraft[] }> {
    const found = await this.findMergeRequest({ project: ref.project, source: ref.ref });
    const calls = [...found.httpCalls];
    if (!found.record) {
      return { httpCalls: calls };
    }
    try {
      const { root, headers } = this.credentials();
      const url = this.mergeRequestUrl(root, ref.project, found.record.iid);
      const comment = `${root}/repos/${repoPath(ref.project)}/issues/${found.record.iid}/comments`;
      this.assertStatus(
        await this.hostRequest(comment, { ...headers, 'Content-Type': 'application/json' }, calls, {
          method: 'POST',
          body: JSON.stringify({ body: reason }),
        }),
        calls,
        this.failure,
      );
      for (const state of ['closed', 'open']) {
        const response = await this.hostRequest(url, { ...headers, 'Content-Type': 'application/json' }, calls, {
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

  protected mergeCall(root: string, project: string, iid: number, head?: string, how?: MergeHow): HostCall {
    return {
      url: `${this.mergeRequestUrl(root, project, iid)}/merge`,
      method: 'PUT',
      payload: JSON.stringify({
        merge_method: how?.method ?? 'squash',
        ...(how?.title ? { commit_title: how.title } : {}),
        ...(head ? { sha: head } : {}),
      }),
    };
  }

  /** The repository's own switches for the three ways GitHub merges a pull request. */
  async readMergeMethods(project: string): Promise<{ methods: MergeMethod[]; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const { root, headers } = this.credentials();
      const repository = (await this.readJson(`${root}/repos/${repoPath(project)}`, headers, calls)) as {
        allow_squash_merge?: boolean;
        allow_rebase_merge?: boolean;
        allow_merge_commit?: boolean;
      } | null;
      const methods: MergeMethod[] = [];
      if (repository?.allow_squash_merge === true) {
        methods.push('squash');
      }
      if (repository?.allow_rebase_merge === true) {
        methods.push('rebase');
      }
      if (repository?.allow_merge_commit === true) {
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
      const base = `${root}/repos/${repoPath(project)}`;
      const repository = (await this.readJson(base, headers, calls)) as { default_branch?: string } | null;
      const branch = repository?.default_branch;
      if (!branch) {
        throw new FetchFailed('github pull request failed', calls);
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
      const sha = await this.readTip(`${root}/repos/${repoPath(ref.project)}`, ref.ref, headers, calls);
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
    const tip = (await this.readJson(`${base}/branches/${encodeURIComponent(branch)}`, headers, calls)) as {
      commit?: { sha?: string };
    } | null;
    if (!tip?.commit?.sha) {
      throw new FetchFailed('github pull request failed', calls);
    }
    return tip.commit.sha;
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

  protected gate(body: unknown): MergeGate {
    const { state, sha, draft } = pullView(body);
    const head = (body as GithubPull | null)?.head?.sha ?? '';
    return { state, sha, draft, head, ...pullMergeability(body) };
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

  /** GitHub puts the reason of a 422 in `errors[].message`, so the text joins it to the message. */
  protected override openRefusal(
    response: { status: number; body: Buffer },
    calls: HttpCallDraft[],
    title: string,
  ): FetchFailed | GitRuleRefused {
    const text = response.status === 422 ? validationText(response.body) : '';
    if (/no commits between/i.test(text)) {
      return new NothingToMerge(text, calls);
    }
    if (text && this.titleRefused(response.status, text)) {
      return new GitRuleRefused(text, title, 'title');
    }
    return text ? new FetchFailed(text, calls) : super.openRefusal(response, calls, title);
  }

  /** A 422 whose text says a rule of the repository refuses the title. */
  protected titleRefused(status: number, message: string): boolean {
    return status === 422 && /title/i.test(message) && /rule|pattern|match|format|convention/i.test(message);
  }

  protected conflict(error: unknown, calls: HttpCallDraft[]): boolean {
    return error instanceof FetchFailed && calls.some((call) => call.statusCode === 422 || call.statusCode === 409);
  }
}

function validationText(body: Buffer): string {
  const message = providerMessage(body);
  let listed: string[] = [];
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { errors?: unknown } | null;
    listed = Array.isArray(parsed?.errors)
      ? (parsed.errors as unknown[]).flatMap((item) => {
          const text = (item as { message?: unknown } | null)?.message;
          return typeof text === 'string' && text.trim() ? [text.trim()] : [];
        })
      : [];
  } catch {
    listed = [];
  }
  const details = listed.join('; ');
  return message && details ? `${message}: ${details}` : message || details;
}

export function repoPath(project: string): string {
  return project
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

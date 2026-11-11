import type { MergeRequestState, MergeRequestView, RequestStateApi } from '../code-host';

export interface GithubPull {
  number?: number;
  html_url?: string;
  body?: string | null;
  head?: { ref?: string; sha?: string };
  state?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  merged_by?: { login?: string } | null;
  closed_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  draft?: boolean;
  node_id?: string;
}

/** A pull request as the merge stage sees it: open, merged with its commit, or closed. */
export function pullView(body: unknown): MergeRequestView {
  const pull = (body ?? {}) as GithubPull;
  const merged = pull.merged === true;
  return {
    state: merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
    sha: merged ? (pull.merge_commit_sha ?? null) : null,
    conflicts: pull.mergeable === false || pull.mergeable_state === 'dirty',
    draft: pull.draft === true,
  };
}

/** GitHub.com serves GraphQL beside the REST root; an Enterprise server serves `/api/graphql` beside `/api/v3`. */
export function graphqlUrl(root: string): string {
  return root.endsWith('/api/v3') ? `${root.slice(0, -'/v3'.length)}/graphql` : `${root}/graphql`;
}

export function apiRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    return 'https://api.github.com';
  }
  return `${url.origin}/api/v3`;
}

/** A pull request with who merged it and when. `closed_by` is not on a pull: the caller reads it from the issue. */
function pullState(body: unknown, now: string): MergeRequestState {
  const pull = (body ?? {}) as GithubPull;
  if (pull.merged === true) {
    return {
      state: 'merged',
      sha: pull.merge_commit_sha ?? null,
      by: pull.merged_by?.login ?? null,
      at: pull.merged_at ?? now,
    };
  }
  return pull.state === 'closed' ? { state: 'closed', by: null, at: pull.closed_at ?? now } : { state: 'open' };
}

export const githubStates: RequestStateApi = {
  stateOf: pullState,
  closerUrl: (requestUrl) => requestUrl.replace(/\/pulls\/(\d+)$/, '/issues/$1'),
};

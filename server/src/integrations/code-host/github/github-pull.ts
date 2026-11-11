import type { MergeRequestView } from '../code-host';

export interface GithubPull {
  number?: number;
  html_url?: string;
  body?: string | null;
  head?: { ref?: string; sha?: string };
  state?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
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

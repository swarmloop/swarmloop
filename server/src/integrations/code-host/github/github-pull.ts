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
}

/** A pull request as the merge stage sees it: open, merged with its commit, or closed. */
export function pullView(body: unknown): MergeRequestView {
  const pull = (body ?? {}) as GithubPull;
  const merged = pull.merged === true;
  return {
    state: merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
    sha: merged ? (pull.merge_commit_sha ?? null) : null,
    conflicts: pull.mergeable === false || pull.mergeable_state === 'dirty',
  };
}

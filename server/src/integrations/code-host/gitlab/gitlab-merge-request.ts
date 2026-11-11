import type { RequestStateApi } from '../code-host';

export interface GitlabMergeRequest {
  iid?: number;
  web_url?: string;
  description?: string | null;
  source_branch?: string;
  sha?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  state?: string;
  merged_at?: string | null;
  merged_by?: { username?: string } | null;
  closed_at?: string | null;
  closed_by?: { username?: string } | null;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  title?: string;
  draft?: boolean;
}

export const gitlabStates: RequestStateApi = {
  stateOf: (body, now) => {
    const merge = (body ?? {}) as GitlabMergeRequest;
    if (merge.state === 'merged') {
      return {
        state: 'merged',
        sha: merge.merge_commit_sha ?? merge.squash_commit_sha ?? merge.sha ?? null,
        by: merge.merged_by?.username ?? null,
        at: merge.merged_at ?? now,
      };
    }
    return merge.state === 'closed'
      ? { state: 'closed', by: merge.closed_by?.username ?? null, at: merge.closed_at ?? now }
      : { state: 'open' };
  },
};

import type { DocumentRepository } from '../../history/document.repository';
import { CODE_REVIEWERS } from '../../contract/steps';
import type { Issue } from '../contract/step-contract';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { latestReview } from '../../agent-result/stored-review';
import { issueOf } from '../shared/handoff';
import { git, gitDetail, gitMissing } from '../../git/git';
import { SwarmloopError } from '../../core/swarmloop-error';
import { fetchBranch } from '../../git/rebase/fetch';
import type { RebaseHosts } from '../../git/rebase/types';
import { withWorktree } from '../../git/worktree-lock';
import { gitAt, type Tree } from './commit-git';

export const NOT_DELIVERED = 'nothing changed and the task is not delivered';

type UnchangedOutcome = { delivered: string } | { issues: Issue[] };

/** The places the requirements review names for the behaviors that are already in the tree. */
function locations(review: ReviewResult): string[] {
  return (review.met ?? []).map((place) => place.trim()).filter((place) => place !== '');
}

/** One tree of the run with its branch, the base it must not differ from, and the hosts its fetch reads. */
export interface BranchOnOrigin {
  tree: Tree;
  branch: string;
  base: string;
  hosts: RebaseHosts;
}

/** The issue text for a branch on origin that holds a change its base lacks; null when it holds none or was never pushed. */
async function ownChangeOn({ tree, branch, base, hosts }: BranchOnOrigin): Promise<string | null> {
  return withWorktree(tree.path, async () => {
    if (!(await fetchBranch(tree.path, tree.repo, branch, hosts))) {
      return null;
    }
    const ref = `refs/remotes/origin/${branch}`;
    try {
      await git(['-C', tree.path, 'diff', '--quiet', base, ref], undefined, { answers: [1] });
      return null;
    } catch (error) {
      if (!gitMissing(error)) {
        throw new SwarmloopError(`${tree.repo} diff failed: ${gitDetail(error)}`);
      }
    }
    const sha = await gitAt(tree, ['rev-parse', ref], 'rev-parse failed');
    return `the branch ${branch} on origin has ${sha} with changes this worktree does not have`;
  });
}

/**
 * What an unchanged tree means. It is delivered only when the last review round passed every reviewer
 * and its requirements review says where each required behavior already is,
 * and no branch of the run on origin holds a change its base lacks. Any other unchanged tree goes back to implement.
 */
export async function unchangedOutcome(
  documents: DocumentRepository,
  key: string,
  branches: BranchOnOrigin[],
): Promise<UnchangedOutcome> {
  const requirements = await latestReview(documents, key, 'requirements');
  if (requirements?.decision === 'ok') {
    const found = locations(requirements);
    const others = await Promise.all(
      CODE_REVIEWERS.filter((name) => name !== 'requirements').map((name) => latestReview(documents, key, name)),
    );
    if (found.length > 0 && others.every((review) => review === null || review.decision === 'ok')) {
      for (const entry of branches) {
        const text = await ownChangeOn(entry);
        if (text) {
          return { issues: [issueOf('commit', text, `${text}\n`)] };
        }
      }
      return { delivered: [...new Set(found)].join('; ') };
    }
  }
  return { issues: [issueOf('commit', NOT_DELIVERED, `${NOT_DELIVERED}\n`)] };
}

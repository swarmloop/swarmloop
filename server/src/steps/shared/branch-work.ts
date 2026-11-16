import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';
import type { Tree } from '../commit/commit-git';

/**
 * Whether a branch has a commit its target does not have. A branch whose head is the target's head, or behind it, has
 * no work to merge. With no known target the branch is taken as work.
 */
export async function hasWorkToMerge(tree: Tree, target: string | null): Promise<boolean> {
  if (!target) {
    return true;
  }
  try {
    await git(['-C', tree.path, 'merge-base', '--is-ancestor', 'HEAD', target], undefined, { answers: [1] });
    return false;
  } catch (error) {
    if (gitMissing(error)) {
      return true;
    }
    throw new SwarmloopError(`${tree.repo} branch failed: ${gitDetail(error)}`);
  }
}

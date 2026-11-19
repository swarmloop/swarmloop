import { git, originUrl } from '../git/git';
import { originRef } from '../git/base-ref';
import { porcelainPaths } from '../git/commit-paths';
import { mergeConflicts } from '../git/merge-tree';
import { commitAllowed } from '../git/rebase/hidden-worktree';
import { status, type Tree } from '../steps/commit/commit-git';
import type { RunEntity } from '../history/entities';
import type { RebasedPublisher } from '../steps/shared/rebased-publisher';

/** What committing the own edits of a parent left: the paths it committed, and the words of a conflict when the branch cannot take them. */
interface TreeSync {
  paths: string[];
  conflict: string | null;
}

/**
 * Commits the uncommitted edits of a parent's worktree with the commit step's rules and puts them on top of the
 * feature branch as it was just fetched from origin, so a later fast-forward has no edits to refuse over.
 */
export class ParentTreeSync {
  constructor(private readonly publisher?: RebasedPublisher) {}

  async commit(parent: RunEntity, tree: Tree, branch: string, message: string): Promise<TreeSync> {
    const remote = originRef(branch);
    const before = await git(['-C', tree.path, 'rev-parse', 'HEAD']);
    const paths = porcelainPaths(await status(tree));
    await commitAllowed(tree.path, tree.repo, [], message);
    if ((await git(['-C', tree.path, 'rev-parse', 'HEAD'])) === before) return { paths: [], conflict: null };
    const files = await mergeConflicts(tree.path, remote);
    if (files.length > 0) {
      await git(['-C', tree.path, 'reset', '-q', before]);
      const tip = await git(['-C', tree.path, 'rev-parse', remote]);
      const conflict =
        `the parent's own uncommitted edits in ${tree.repo} conflict with ${remote} in ${files.join(', ')}: ` +
        `the worktree is at ${before}, ${remote} is at ${tip}; nothing was committed or pushed and the edits stay ` +
        'in the worktree; resolve the files, then Resume or send a message';
      return { paths: [], conflict };
    }
    try {
      await git(['-C', tree.path, 'rebase', remote]);
    } catch (error) {
      await git(['-C', tree.path, 'rebase', '--abort']).catch(() => undefined);
      await git(['-C', tree.path, 'reset', '-q', before]);
      throw error;
    }
    await this.push(parent, tree, branch);
    return { paths, conflict: null };
  }

  /** Publishes the rebased commit. The lease is the fetched tip, taken after the rebase, so a merged task is never dropped. */
  private async push(parent: RunEntity, tree: Tree, branch: string): Promise<void> {
    const origin = await originUrl(tree.path, tree.repo, 'origin failed');
    if (!origin || !this.publisher) return;
    const leased = await this.publisher.optionalRev(tree, `refs/remotes/${originRef(branch)}`);
    await this.publisher.pushRef(tree, branch, leased, parent, origin);
  }
}

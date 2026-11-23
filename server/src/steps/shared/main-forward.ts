import { git } from '../../git/git';
import { storedBase } from '../../git/rebase';
import type { RebaseHosts } from '../../git/rebase/types';
import { worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import { hasWorkToMerge } from './branch-work';

/**
 * Moves each worktree whose branch has nothing of its own to the head of main. Main's head already holds such a
 * branch, so a rebase has nothing to squash; the branch goes forward to the head instead. The head of main each
 * moved repository went to, by repository.
 */
export async function forwardOwnLess(input: {
  root: string;
  key: string;
  repos: string[];
  prompt: string | null;
  hosts: RebaseHosts;
}): Promise<Map<string, string>> {
  const moved = new Map<string, string>();
  for (const repo of input.repos) {
    const path = worktreePath(input.root, input.key, repo);
    await withWorktree(path, async () => {
      const base = await storedBase(path, repo, input.prompt, input.hosts, 'rebase');
      if (base === 'HEAD' || (await hasWorkToMerge({ repo, path }, base))) return;
      await git(['-C', path, 'merge', '--ff-only', base]);
      moved.set(repo, await git(['-C', path, 'rev-parse', 'HEAD']));
    });
  }
  return moved;
}

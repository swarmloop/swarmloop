import { existsSync } from 'fs';
import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef } from '../../git/base-ref';
import { commitIdentity, git, gitDetail, type CommitAuthor } from '../../git/git';
import { fingerprintOf, unmergedPaths, type RebaseStop } from '../../git/rebase';
import { atOrPast, type RebaseJournal } from '../../git/rebase/journal';
import { resolveGitPath } from '../../git/rebase/hidden-worktree';
import { worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import type { RebasedPublisher } from '../shared/rebased-publisher';

/** True while git holds a rebase in the worktree: it stopped at a conflict and waits for the files. */
function rebasing(cwd: string): Promise<boolean> {
  return withWorktree(cwd, async () => {
    const path = await resolveGitPath(cwd, 'rebase-merge');
    return path !== null && existsSync(path);
  });
}

/** True when the head of the worktree holds the feature branch from origin and goes beyond it. */
function ahead(cwd: string, remote: string): Promise<boolean> {
  return withWorktree(cwd, async () => {
    const holds = await git(['-C', cwd, 'merge-base', '--is-ancestor', remote, 'HEAD']).then(
      () => true,
      () => false,
    );
    return holds && (await git(['-C', cwd, 'rev-parse', 'HEAD'])) !== (await git(['-C', cwd, 'rev-parse', remote]));
  });
}

/** What the continue of a parent's own-edits rebase reads and writes. */
interface OwnEditsRebase {
  root: string;
  key: string;
  repos: string[];
  branch: string;
  journal: RebaseJournal;
  publisher: RebasedPublisher;
  author: CommitAuthor | null;
  onBase: (repo: string, sha: string) => void;
}

/** Stages what the agent resolved and takes the rebase on. A stop at the next commit leaves the rebase open. */
function continueRebase(cwd: string, repo: string, author: CommitAuthor | null): Promise<void> {
  return withWorktree(cwd, async () => {
    const still = await unmergedPaths(cwd);
    try {
      if (still.length > 0) await git(['-C', cwd, 'add', '--', ...still]);
      const identity = await commitIdentity(cwd, author);
      await git(['-C', cwd, ...identity.args, '-c', 'core.editor=true', 'rebase', '--continue'], identity.env);
    } catch (error) {
      if (!(await rebasing(cwd))) throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
    }
  });
}

/**
 * The continue of a parent's own-edits conflict, which the pass parked as a rebase that stopped. It takes the rebase of
 * `resolved` on (the repository the agent just worked in), then stops at the first repository whose rebase is still
 * open. With none open (a crash cut the visit short, or the rebase ended) the entries are applied and the branch is
 * published with the leases of the repositories that go beyond origin.
 */
export async function continueOwnEdits(input: OwnEditsRebase, resolved: string | null): Promise<RebaseStop> {
  const cwdOf = (repo: string) => worktreePath(input.root, input.key, repo);
  if (resolved !== null) await continueRebase(cwdOf(resolved), resolved, input.author);
  for (const repo of input.repos) {
    const cwd = cwdOf(repo);
    if (!(await rebasing(cwd))) continue;
    const files = await withWorktree(cwd, () => unmergedPaths(cwd));
    return { kind: 'conflict', repo, files, stderr: '', base: '', commit: '' };
  }
  for (const repo of input.repos) {
    const entry = await input.journal.entry(repo);
    // A completed entry is history: its base is not a move of this visit.
    if (!entry || entry.checkpoint === 'completed') continue;
    input.onBase(repo, entry.baseSha);
    if (!atOrPast(entry, 'applied')) {
      await input.journal.advance(repo, 'applied', { fingerprint: await fingerprintOf(cwdOf(repo)) });
    }
  }
  const leases: { repo: string; tip: string | null }[] = [];
  for (const tree of input.publisher.trees(input.key, input.repos)) {
    if (!(await ahead(tree.path, originRef(input.branch)))) continue;
    leases.push({
      repo: tree.repo,
      tip: await input.publisher.optionalRev(tree, `refs/remotes/${originRef(input.branch)}`),
    });
  }
  return { kind: 'clean', leases };
}

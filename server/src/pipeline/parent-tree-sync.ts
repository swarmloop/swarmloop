import { commitIdentity, git, originUrl, type CommitAuthor } from '../git/git';
import { originRef } from '../git/base-ref';
import { porcelainPaths } from '../git/commit-paths';
import { fingerprintOf, ownChangeBase, unmergedPaths } from '../git/rebase';
import { protectRef } from '../git/rebase/journal';
import { mergeConflicts } from '../git/merge-tree';
import { commitAllowed } from '../git/rebase/hidden-worktree';
import { status, type Tree } from '../steps/commit/commit-git';
import type { RunEntity } from '../history/entities';
import { GitRuleRefused } from '../core/git-rule-refused';
import { GitRulesError } from '../core/swarmloop-error';
import type { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { runJournal } from '../steps/shared/rebase-journal';
import type { DocumentRepository } from '../history/document.repository';

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
  constructor(
    private readonly publisher?: RebasedPublisher,
    private readonly documents?: DocumentRepository,
  ) {}

  /**
   * With `park` a conflict is not undone: the commit is rebased onto the feature branch and git stops at the
   * conflicting files, which the implement agent resolves. Without it the edits go back to the worktree.
   */
  async commit(
    parent: RunEntity,
    tree: Tree,
    branch: string,
    message: string,
    park: boolean,
    author: CommitAuthor | null,
    stood: string[] = [],
  ): Promise<TreeSync> {
    const remote = originRef(branch);
    const before = await git(['-C', tree.path, 'rev-parse', 'HEAD']);
    const paths = porcelainPaths(await status(tree));
    await commitAllowed(tree.path, tree.repo, [], message, author);
    if ((await git(['-C', tree.path, 'rev-parse', 'HEAD'])) === before) return { paths: [], conflict: null };
    // The edits and any commit the branch lacks are replayed, from the tip the worktree stood on: not what a rewritten branch left behind.
    const ownBase = await ownChangeBase(tree.path, stood, remote);
    const files = await mergeConflicts(tree.path, remote, ownBase);
    if (files.length > 0 && !park) {
      await git(['-C', tree.path, 'reset', '-q', before]);
      return { paths: [], conflict: await this.conflictText(tree, remote, before, files, false) };
    }
    // The entry is written before the rebase, as every move is: a conflict parks it at 'conflict' for implement.
    const journal = this.documents ? runJournal(this.documents, parent) : null;
    const tip = await git(['-C', tree.path, 'rev-parse', remote]);
    await journal?.put(tree.repo, {
      path: tree.path,
      branch,
      oldHead: await git(['-C', tree.path, 'rev-parse', 'HEAD']),
      fingerprint: await fingerprintOf(tree.path),
      protectRef: protectRef(branch),
      expectedRemoteTip: tip,
      baseSha: tip,
      ownBase,
      checkpoint: 'applying',
    });
    try {
      await git(['-C', tree.path, 'rebase', '--onto', remote, ownBase], (await commitIdentity(tree.path, author)).env);
    } catch (error) {
      if (park && files.length > 0 && (await unmergedPaths(tree.path)).length > 0) {
        await journal?.advance(tree.repo, 'conflict');
        return { paths: [], conflict: await this.conflictText(tree, remote, before, files, true) };
      }
      await git(['-C', tree.path, 'rebase', '--abort']).catch(() => undefined);
      await git(['-C', tree.path, 'reset', '-q', before]);
      // An aborted rebase is history: the settler never resumes it.
      await journal?.advance(tree.repo, 'completed');
      throw error;
    }
    await journal?.advance(tree.repo, 'applied', { fingerprint: await fingerprintOf(tree.path) });
    await this.push(parent, tree, branch);
    await journal?.advance(tree.repo, 'completed');
    return { paths, conflict: null };
  }

  private async conflictText(
    tree: Tree,
    remote: string,
    before: string,
    files: string[],
    parked: boolean,
  ): Promise<string> {
    const tip = await git(['-C', tree.path, 'rev-parse', remote]);
    const fate = parked
      ? `the edits are committed on top of ${remote} in a rebase that stops at the conflicting files, which the implement agent resolves; nothing was pushed`
      : 'nothing was committed or pushed and the edits stay in the worktree';
    return (
      `the parent's own uncommitted edits in ${tree.repo} conflict with ${remote} in ${files.join(', ')}: ` +
      `the worktree is at ${before}, ${remote} is at ${tip}; ${fate}`
    );
  }

  /** Publishes the rebased commit. The lease is the fetched tip, taken after the rebase, so a merged task is never dropped. */
  private async push(parent: RunEntity, tree: Tree, branch: string): Promise<void> {
    const origin = await originUrl(tree.path, tree.repo, 'origin failed');
    if (!origin || !this.publisher) return;
    const leased = await this.publisher.optionalRev(tree, `refs/remotes/${originRef(branch)}`);
    try {
      await this.publisher.pushRef(tree, branch, leased, parent, origin, 'commit');
    } catch (error) {
      throw error instanceof GitRuleRefused ? new GitRulesError(error.hostMessage, error.name) : error;
    }
  }
}

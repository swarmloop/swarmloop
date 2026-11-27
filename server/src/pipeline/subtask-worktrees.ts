import { existsSync } from 'fs';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import { FetchFailed } from '../core/swarmloop-error';
import { fetchBranch, ownChangeBase } from '../git/rebase';
import { withWorktree } from '../git/worktree-lock';
import { originRef } from '../git/base-ref';
import { git, type CommitAuthor } from '../git/git';
import { mergeConflicts } from '../git/merge-tree';
import { worktreePath } from '../git/repo-names';
import { root } from '../history/run-paths';
import { originProject } from '../steps/pipeline/pipeline-report';
import type { RunEntity } from '../history/entities';
import type { BaseTips } from '../steps/shared/base-tips';
import type { RebasedPublisher } from '../steps/shared/rebased-publisher';
import type { OwnEdits } from '../steps/shared/subtask-ops';
import { status, type Tree } from '../steps/commit/commit-git';
import { ParentTreeSync } from './parent-tree-sync';

/** The git side of the subtask operations: what the worktrees of a parent and its subtask runs hold against the feature branch on origin. */
export class SubtaskWorktrees {
  private readonly logger = new Logger(SubtaskWorktrees.name);

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly tips: BaseTips,
    private readonly publisher?: RebasedPublisher,
  ) {}

  private async hostsFor(run: RunEntity) {
    return (await this.publisher?.hostsFor(run)) ?? { ...this.config.env, clock: this.clock };
  }

  /**
   * Brings the worktrees of a subtask run, edits that are not committed included, up to the feature branch as it is on
   * origin. Only the run's own change is replayed, from the base tip it stands on, so a rewritten branch brings nothing else.
   */
  async catchUp(run: RunEntity, repos: string[], branch: string): Promise<void> {
    const hosts = await this.hostsFor(run);
    const known = await this.tips.known(run, repos);
    for (const repo of repos) {
      const path = worktreePath(root(this.config), run.key, repo);
      if (!existsSync(path)) continue;
      await withWorktree(path, async () => {
        if (!(await fetchBranch(path, repo, branch, hosts))) return;
        const remote = originRef(branch);
        try {
          const ownBase = await ownChangeBase(path, known[repo] ?? [], remote);
          await git(['-C', path, 'rebase', '--autostash', '--onto', remote, ownBase]);
          await this.tips.record(run, { [repo]: await git(['-C', path, 'rev-parse', remote]) });
        } catch (error) {
          await git(['-C', path, 'rebase', '--abort']).catch(() => undefined);
          this.logger.warn(`${run.key} was not caught up: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }

  /**
   * Commits the uncommitted edits of the parent's worktrees onto the feature branch as it is on origin, so the
   * fast-forward that follows never meets them. Stops at the first repository whose edits conflict. With `park` a
   * conflict stays in that worktree as a rebase that stopped, for the implement agent to resolve.
   */
  async commitOwnEdits(
    parent: RunEntity,
    repos: string[],
    branch: string,
    commitAs: () => Promise<{ message: (repo: string) => string; author: CommitAuthor | null }>,
    park: boolean,
  ): Promise<OwnEdits> {
    const hosts = await this.hostsFor(parent);
    const sync = new ParentTreeSync(this.publisher);
    const known = await this.tips.known(parent, repos);
    const lines: string[] = [];
    let identity: Awaited<ReturnType<typeof commitAs>> | null = null;
    for (const repo of repos) {
      const path = worktreePath(root(this.config), parent.key, repo);
      if (!existsSync(path)) continue;
      const ready = await withWorktree(
        path,
        async () => (await this.hasEdits({ repo, path })) && (await fetchBranch(path, repo, branch, hosts)),
      );
      if (!ready) continue;
      // The message and the author cost document reads and host calls: only a repository with edits needs them.
      identity ??= await commitAs();
      const { message, author } = identity;
      const { paths, conflict } = await withWorktree(path, () =>
        sync.commit(parent, { repo, path }, branch, message(repo), park, author, known[repo] ?? []),
      );
      if (paths.length > 0) lines.push(`committed the parent's own edits in ${repo}: ${paths.join(', ')}`);
      if (conflict) return { committed: lines.join('; ') || null, conflict };
    }
    return { committed: lines.join('; ') || null, conflict: null };
  }

  /** True when the worktree has edits that are not committed. A directory git cannot read has none to commit. */
  private async hasEdits(tree: Tree): Promise<boolean> {
    return (await status(tree).catch(() => '')) !== '';
  }

  /**
   * Moves the worktrees of the parent to the feature branch as it is on origin. A worktree with commits the branch
   * lacks, or with edits the move would overwrite, stays where it is; the result names both heads. Null when every worktree moved.
   */
  async fastForward(parent: RunEntity, repos: string[], branch: string): Promise<string | null> {
    const hosts = await this.hostsFor(parent);
    const notes: string[] = [];
    for (const repo of repos) {
      const path = worktreePath(root(this.config), parent.key, repo);
      if (!existsSync(path)) continue;
      await withWorktree(path, async () => {
        if (!(await fetchBranch(path, repo, branch, hosts))) return;
        try {
          await git(['-C', path, 'merge', '--ff-only', originRef(branch)]);
        } catch (error) {
          const remote = originRef(branch);
          const ahead = await git(['-C', path, 'merge-base', '--is-ancestor', 'HEAD', remote]).then(
            () => false,
            () => true,
          );
          const edited = await this.hasEdits({ repo, path });
          if (!ahead && !edited) throw error;
          const local = await git(['-C', path, 'rev-parse', 'HEAD']);
          const tip = await git(['-C', path, 'rev-parse', remote]);
          const lacks = ahead ? `it has commits that ${remote} at ${tip} lacks` : `its edits are not committed yet`;
          notes.push(`the worktree of ${repo} stays at ${local}: ${lacks}, so it was not moved to the feature branch`);
        }
      });
    }
    return notes.length > 0 ? notes.join('; ') : null;
  }

  /**
   * The tip of the feature branch, when a worktree head of the run does not contain it. Null when every head does.
   * A worktree that retention removed is behind by definition: the tip is read from the parent's worktree and the
   * rebase brings the worktree back. A branch that cannot be fetched leaves it unknown: that is a FetchFailed, never "on top".
   */
  async behindTip(parent: RunEntity, run: RunEntity, repos: string[], branch: string): Promise<string | null> {
    const hosts = await this.hostsFor(run);
    for (const repo of repos) {
      const path = worktreePath(root(this.config), run.key, repo);
      if (!existsSync(path)) return this.tipOf(parent, repo, branch);
      const tip = await withWorktree(path, async () => {
        if (!(await fetchBranch(path, repo, branch, hosts)))
          throw new FetchFailed(`${branch} of ${repo} could not be fetched`);
        try {
          await git(['-C', path, 'merge-base', '--is-ancestor', originRef(branch), 'HEAD']);
          return null;
        } catch {
          return git(['-C', path, 'rev-parse', originRef(branch)]);
        }
      });
      if (tip !== null) return tip;
    }
    return null;
  }

  /** The tip of the feature branch on origin, read in the worktree of the parent. */
  private async tipOf(parent: RunEntity, repo: string, branch: string): Promise<string> {
    const path = worktreePath(root(this.config), parent.key, repo);
    const hosts = await this.hostsFor(parent);
    return withWorktree(path, async () => {
      if (!existsSync(path) || !(await fetchBranch(path, repo, branch, hosts))) {
        throw new FetchFailed(`${branch} of ${repo} could not be fetched`);
      }
      return git(['-C', path, 'rev-parse', originRef(branch)]);
    });
  }

  /**
   * The files each merge commit of a task changed, from the repository's own worktree of the run. A path is prefixed
   * with its repository when the task merged into more than one.
   */
  async changedFiles(run: RunEntity, merged: Record<string, string>, branch: string): Promise<string[]> {
    const hosts = await this.hostsFor(run);
    const repos = Object.entries(merged).filter(([, sha]) => sha);
    const files: string[] = [];
    for (const [repo, sha] of repos) {
      const path = worktreePath(root(this.config), run.key, repo);
      if (!existsSync(path)) continue;
      const names = await withWorktree(path, async () =>
        (await fetchBranch(path, repo, branch, hosts))
          ? git(['-C', path, 'diff', '--name-only', `${sha}^`, sha])
          : null,
      );
      if (names === null) continue;
      files.push(
        ...names
          .split('\n')
          .filter(Boolean)
          .map((name) => (repos.length > 1 ? `${repo}/${name}` : name)),
      );
    }
    return files;
  }

  /** The project the origin of a repository's worktree names, or null when the worktree or its origin cannot be read. */
  projectOf(run: RunEntity, repo: string): Promise<string | null> {
    const path = worktreePath(root(this.config), run.key, repo);
    return withWorktree(path, () => originProject(path));
  }

  /** The files git cannot merge between the feature branch and the heads of the run. */
  async conflictFiles(run: RunEntity, repos: string[], branch: string): Promise<string[]> {
    const hosts = await this.hostsFor(run);
    const files: string[] = [];
    for (const repo of repos) {
      const path = worktreePath(root(this.config), run.key, repo);
      if (!existsSync(path)) continue;
      const found = await withWorktree(path, async () =>
        (await fetchBranch(path, repo, branch, hosts)) ? mergeConflicts(path, originRef(branch)) : [],
      );
      files.push(...found);
    }
    return files;
  }
}

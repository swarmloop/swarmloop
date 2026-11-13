import { existsSync } from 'fs';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import { FetchFailed } from '../core/swarmloop-error';
import { fetchBranch } from '../git/rebase';
import { originRef } from '../git/base-ref';
import { git } from '../git/git';
import { worktreePath } from '../git/repo-names';
import { root } from '../history/run-paths';
import type { RunEntity } from '../history/entities';
import type { RebasedPublisher } from '../steps/shared/rebased-publisher';

/** The git side of the subtask operations: what the worktrees of a parent and its subtask runs hold against the feature branch on origin. */
export class SubtaskWorktrees {
  private readonly logger = new Logger(SubtaskWorktrees.name);

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly publisher?: RebasedPublisher,
  ) {}

  private async hostsFor(run: RunEntity) {
    return (await this.publisher?.hostsFor(run)) ?? { ...this.config.env, clock: this.clock };
  }

  /** Brings the worktrees of a subtask run, edits that are not committed included, up to the feature branch as it is on origin. */
  async catchUp(run: RunEntity, repos: string[], branch: string): Promise<void> {
    const hosts = await this.hostsFor(run);
    for (const repo of repos) {
      const path = worktreePath(root(this.config), run.key, repo);
      if (!existsSync(path) || !(await fetchBranch(path, repo, branch, hosts))) continue;
      try {
        await git(['-C', path, 'rebase', '--autostash', originRef(branch)]);
      } catch (error) {
        await git(['-C', path, 'rebase', '--abort']).catch(() => undefined);
        this.logger.warn(`${run.key} was not caught up: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Moves the worktrees of the parent to the feature branch as it is on origin. */
  async fastForward(parent: RunEntity, repos: string[], branch: string): Promise<void> {
    const hosts = await this.hostsFor(parent);
    for (const repo of repos) {
      const path = worktreePath(root(this.config), parent.key, repo);
      if (existsSync(path) && (await fetchBranch(path, repo, branch, hosts))) {
        await git(['-C', path, 'merge', '--ff-only', originRef(branch)]);
      }
    }
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
      if (!(await fetchBranch(path, repo, branch, hosts)))
        throw new FetchFailed(`${branch} of ${repo} could not be fetched`);
      try {
        await git(['-C', path, 'merge-base', '--is-ancestor', originRef(branch), 'HEAD']);
      } catch {
        return git(['-C', path, 'rev-parse', originRef(branch)]);
      }
    }
    return null;
  }

  /** The tip of the feature branch on origin, read in the worktree of the parent. */
  private async tipOf(parent: RunEntity, repo: string, branch: string): Promise<string> {
    const path = worktreePath(root(this.config), parent.key, repo);
    if (!existsSync(path) || !(await fetchBranch(path, repo, branch, await this.hostsFor(parent)))) {
      throw new FetchFailed(`${branch} of ${repo} could not be fetched`);
    }
    return git(['-C', path, 'rev-parse', originRef(branch)]);
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
      if (!existsSync(path) || !(await fetchBranch(path, repo, branch, hosts))) continue;
      const names = await git(['-C', path, 'diff', '--name-only', `${sha}^`, sha]);
      files.push(
        ...names
          .split('\n')
          .filter(Boolean)
          .map((name) => (repos.length > 1 ? `${repo}/${name}` : name)),
      );
    }
    return files;
  }

  /** The files git cannot merge between the feature branch and the heads of the run. */
  async conflictFiles(run: RunEntity, repos: string[], branch: string): Promise<string[]> {
    const hosts = await this.hostsFor(run);
    const files: string[] = [];
    for (const repo of repos) {
      const path = worktreePath(root(this.config), run.key, repo);
      if (!existsSync(path) || !(await fetchBranch(path, repo, branch, hosts))) continue;
      try {
        await git([
          '-C',
          path,
          'merge-tree',
          '--write-tree',
          '--name-only',
          '--no-messages',
          originRef(branch),
          'HEAD',
        ]);
      } catch (error) {
        const out = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
        files.push(...out.split('\n').slice(1).filter(Boolean));
      }
    }
    return files;
  }
}

import { existsSync } from 'fs';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/env';
import { git } from '../../git/git';
import { worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import { root } from '../../history/run-paths';

/** Tells whether the worktree of a run already holds a commit of main. */
@Injectable()
export class MainHeld {
  constructor(private readonly config: AppConfig) {}

  /** True when the run's worktree of `repo` has `sha` in its history; a missing worktree or a commit it never fetched is false. */
  async holds(runKey: string, repo: string, sha: string): Promise<boolean> {
    const path = worktreePath(root(this.config), runKey, repo);
    if (!existsSync(path)) return false;
    return withWorktree(path, () =>
      git(['-C', path, 'merge-base', '--is-ancestor', sha, 'HEAD']).then(
        () => true,
        () => false,
      ),
    );
  }
}

import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { root } from '../../history/run-paths';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';
import { worktreePath } from '../../git/repo-names';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { StepKernel } from '../step-kernel';

/** Puts a run's worktree on the branch of its requirements, leaving another run's commits under a ref. */
@Injectable()
export class BranchCheckout {
  constructor(private readonly kernel: StepKernel) {}

  branchFor(key: string, requirements: string | null): string {
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    return branchName(key, summaryForBranch(requirements, key));
  }

  async ensure(key: string, repo: string, requirements: string | null, committed: boolean): Promise<void> {
    await this.checkout(key, repo, this.branchFor(key, requirements), committed);
  }

  async checkout(key: string, repo: string, branch: string, committed: boolean): Promise<void> {
    const worktree = worktreePath(root(this.kernel.config), key, repo);
    if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
      throw new SwarmloopError(`${repo} is not a worktree`);
    }
    const current = await git(['-C', worktree, 'branch', '--show-current']);
    if (current === branch) {
      return;
    }
    const dirty = await git(['-C', worktree, 'status', '--porcelain']);
    if (dirty) {
      throw new SwarmloopError(`${repo} worktree is dirty`);
    }
    try {
      if (await hasBranch(worktree, branch)) {
        if (committed) {
          await git(['-C', worktree, 'switch', branch]);
          return;
        }
        // Someone else's branch starts again from the current base, so the run gets today's code and .swarmloop.json.
        // Its commits stay under refs/swarmloop/earlier/, and the next push replaces the remote branch with a lease.
        if (!(await isAncestor(worktree, branch, 'HEAD'))) {
          const tip = await git(['-C', worktree, 'rev-parse', `refs/heads/${branch}`]);
          await git(['-C', worktree, 'update-ref', `refs/swarmloop/earlier/${branch}`, tip]);
        }
        await git(['-C', worktree, 'switch', '-C', branch]);
        return;
      }
      await git(['-C', worktree, 'switch', '-c', branch]);
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw error;
      }
      throw new SwarmloopError(`${repo} branch failed: ${gitDetail(error)}`);
    }
  }
}

async function isAncestor(worktree: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(['-C', worktree, 'merge-base', '--is-ancestor', older, newer], undefined, { answers: [1] });
    return true;
  } catch {
    return false;
  }
}

async function hasBranch(worktree: string, branch: string): Promise<boolean> {
  try {
    await git(['-C', worktree, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], undefined, { answers: [1] });
    return true;
  } catch (error) {
    if (gitMissing(error)) {
      return false;
    }
    throw error;
  }
}

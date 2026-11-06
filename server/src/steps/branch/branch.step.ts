import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { existsSync, statSync } from 'fs';
import { root } from '../../history/run-paths';
import { StepName } from '../../contract/steps';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { branchName, summaryForBranch } from './branch-name';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

const INPUTS = {
  requirements: { artifact: ARTIFACTS.requirements, need: 'run' },
  repos: { artifact: ARTIFACTS.repos, need: 'start' },
  pipelineRef: { artifact: ARTIFACTS.pipelineRef, need: 'optional' },
} as const satisfies InputSpec;

@Injectable()
export class BranchStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'branch';
  readonly inputs = INPUTS;
  readonly outputs = [];

  constructor(kernel: StepKernel) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { key } = ctx.opened.run;
    const name = this.branchFor(key, input.requirements);
    // A run that has committed owns the commits of its branch. Before that, a branch of the same name was left by
    // an earlier run of this key, such as one removed in the panel.
    const committed = input.pipelineRef !== null;
    for (const repo of checkedRepoNames(input.repos ?? [])) {
      await this.checkout(key, repo, name, committed);
    }
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} branch done\n${name}`,
      outputs: [],
      handoff: `- checked out ${name}\n`,
    };
  }

  async ensure(key: string, repo: string, requirements: string | null, committed: boolean): Promise<void> {
    await this.checkout(key, repo, this.branchFor(key, requirements), committed);
  }

  private branchFor(key: string, requirements: string | null): string {
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    return branchName(key, summaryForBranch(requirements, key));
  }

  private async checkout(key: string, repo: string, branch: string, committed: boolean): Promise<void> {
    const worktree = worktreePath(root(this.config), key, repo);
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
    await git(['-C', worktree, 'merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false;
  }
}

async function hasBranch(worktree: string, branch: string): Promise<boolean> {
  try {
    await git(['-C', worktree, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (gitMissing(error)) {
      return false;
    }
    throw error;
  }
}

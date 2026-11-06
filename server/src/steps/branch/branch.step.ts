import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { existsSync, statSync } from 'fs';
import { root } from '../../history/run-paths';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';
import { recordHandoff } from '../shared/handoff';
import { repoNames, worktreePath } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { branchName, summaryForBranch } from './branch-name';
import { ARTIFACTS } from '../contract/artifacts';

@Injectable()
export class BranchStep extends BaseStep {
  readonly name: StepName = 'branch';
  readonly requiredKind = ARTIFACTS.repos.kind;

  constructor(kernel: StepKernel) {
    super(kernel);
  }

  protected async run(key: string, _options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    const requirements = await this.documents.latestBody(key, ARTIFACTS.requirements.kind);
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    const repos = await this.documents.latestBody(key, ARTIFACTS.repos.kind);
    const names = repoNames(repos ?? '');
    const name = branchName(key, summaryForBranch(requirements, key));
    for (const repo of names) {
      await this.ensure(key, repo);
    }
    const handoff = await recordHandoff(this.documents, key, 'branch', `- checked out ${name}\n`);
    return ctx.end({
      outcome: 'ok',
      exitCode: 0,
      line: `${ctx.opened.startedAt} branch done\n${name}`,
      visit: { documents: [handoff] },
    });
  }

  async ensure(key: string, repo: string): Promise<void> {
    const requirements = await this.documents.latestBody(key, ARTIFACTS.requirements.kind);
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    // A run that has committed owns the commits of its branch. Before that, a branch of the same name was left by
    // an earlier run of this key, such as one removed in the panel.
    const committed = (await this.documents.latestBody(key, ARTIFACTS.pipelineRef.kind)) !== null;
    await this.checkout(key, repo, branchName(key, summaryForBranch(requirements, key)), committed);
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

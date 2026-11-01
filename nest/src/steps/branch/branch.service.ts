import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { HistoryService } from '../../history/history.service';
import { PipelineResult, StepName, StepOptions } from '../../pipeline/pipeline-result';
import { SwarmloopError } from '../../swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';
import { recordHandoff } from '../model-step';
import { repoNames, worktreePath } from '../repo-names';
import { BaseStep, StepContext } from '../base-step';
import { branchName, summaryForBranch } from './branch-name';

@Injectable()
export class BranchService extends BaseStep {
  readonly name: StepName = 'branch';
  readonly requiredKind = 'repos';

  constructor(history: HistoryService) {
    super(history);
  }

  protected async run(key: string, _options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    const requirements = await this.history.latestBody(key, 'requirements');
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    const repos = await this.history.latestBody(key, 'repos');
    const names = repoNames(repos ?? '');
    const name = branchName(key, summaryForBranch(requirements, key));
    for (const repo of names) {
      await this.ensure(key, repo);
    }
    const handoff = await recordHandoff(this.history, key, 'branch', `- checked out ${name}\n`);
    return ctx.end({ outcome: 'ok', exitCode: 0, line: `${ctx.opened.startedAt} branch done\n${name}`, visit: { documents: [handoff] } });
  }

  async ensure(key: string, repo: string): Promise<void> {
    const requirements = await this.history.latestBody(key, 'requirements');
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    await this.checkout(key, repo, branchName(key, summaryForBranch(requirements, key)));
  }

  private async checkout(key: string, repo: string, branch: string): Promise<void> {
    const worktree = worktreePath(this.history.root(), key, repo);
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
        await git(['-C', worktree, 'switch', branch]);
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


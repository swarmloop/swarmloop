import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { AppConfig } from '../../config/env';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { root } from '../../history/run-paths';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { Clock } from '../../core/clock';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';
import { recordHandoff } from '../shared/handoff';
import { repoNames, worktreePath } from '../shared/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { branchName, summaryForBranch } from './branch-name';

@Injectable()
export class BranchStep extends BaseStep {
  readonly name: StepName = 'branch';
  readonly requiredKind = 'repos';

  constructor(
    runs: RunRepository,
    documents: DocumentRepository,
    visits: VisitRepository,
    flows: FlowRepository,
    clock: Clock,
    config: AppConfig,
  ) {
    super(runs, documents, visits, flows, clock, config);
  }

  protected async run(key: string, _options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    const requirements = await this.documents.latestBody(key, 'requirements');
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    const repos = await this.documents.latestBody(key, 'repos');
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
    const requirements = await this.documents.latestBody(key, 'requirements');
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    await this.checkout(key, repo, branchName(key, summaryForBranch(requirements, key)));
  }

  private async checkout(key: string, repo: string, branch: string): Promise<void> {
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
        // A branch left by an earlier try of this key without work of its own starts again from the current base,
        // so the run gets today's code and .swarmloop.json. A branch with commits keeps them.
        const empty = await isAncestor(worktree, branch, 'HEAD');
        await git(['-C', worktree, 'switch', ...(empty ? ['-C'] : []), branch]);
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

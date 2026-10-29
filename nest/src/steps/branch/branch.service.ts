import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, sampleSelf, VisitDraft } from '../../history/visit';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { PipelineResult } from '../../pipeline/pipeline-result';
import { SwarmloopError } from '../../swarmloop-error';
import { git, gitDetail, gitMissing } from '../git';
import { recordHandoff } from '../model-step';
import { repoNames, worktreePath } from '../repo-names';
import { branchName, summaryForBranch } from './branch-name';

@Injectable()
export class BranchService {
  constructor(private readonly history: HistoryService) {}

  async execute(key: string): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'branch');
    const end = (outcome: 'ok' | 'failed', status: string, exitCode: number, line: string, documents?: DocumentDraft[]) =>
      closeStep({
        history: this.history,
        run: opened.run,
        previousStep: opened.previousStep,
        previousStatus: opened.previousStatus,
        step: 'branch',
        outcome,
        visit: { ...branchVisit(opened, status, exitCode), ...(documents ? { documents } : {}) },
        line,
        exitCode,
      });
    try {
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
      return end('ok', 'done', 0, `${opened.startedAt} branch done\n${name}`, [handoff]);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'branch failed';
      return end('failed', 'failed', 1, `${opened.startedAt} ${message}`);
    }
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

function branchVisit(opened: OpenedStep, status: string, exitCode: number): VisitDraft {
  return {
    step: 'branch',
    model: null,
    mode: null,
    startedAt: opened.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - opened.started,
    status,
    exitCode,
    killReason: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    samples: [sampleSelf()],
    exchange: null,
    httpCalls: [],
    document: null,
    resumed: false,
  };
}


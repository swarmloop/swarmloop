import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../config/env';
import { RunEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { branchName, commitMessage, summaryForBranch } from '../steps/branch/branch-name';
import { REBASE_MERGE_SKIP } from '../steps/merge-request/merge-request.service';
import { REBASE_CONFLICT, rebaseFeatureRepos } from '../git/rebase-worktree';
import { repoNames } from '../steps/repo-names';
import { SwarmloopError } from '../swarmloop-error';
import { RunCommandsService } from './run-commands.service';
import { requireRun } from './run-queries.service';

@Injectable()
export class RunRebaseService {
  constructor(
    private readonly history: HistoryService,
    private readonly pipeline: PipelineService,
    private readonly config: ConfigService,
    private readonly commands: RunCommandsService,
  ) {}

  async rebase(key: string): Promise<{ http: number; body: { key: string; status: string } }> {
    const run = await requireRun(this.history, key);
    if (run.status !== 'failed' && run.status !== 'done' && run.status !== 'waiting') {
      throw new ConflictException(`${key} is ${run.status}`);
    }
    const status = run.status;
    let stop: Awaited<ReturnType<typeof rebaseFeatureRepos>>;
    try {
      stop = await this.rebaseWorktrees(run);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'rebase failed';
      throw new ConflictException(message);
    }
    if (stop.kind === 'conflict') {
      const unfinished = await this.checklistUnfinished(run);
      await this.history.putDocument(run, REBASE_CONFLICT, unfinished ? 'pending-implement\n' : 'pending\n');
      return this.startAtImplement(run);
    }
    if (await this.checklistUnfinished(run)) {
      return this.startAtImplement(run);
    }
    if (status === 'failed' || status === 'waiting') {
      return this.commands.resume(key);
    }
    const fresh = await requireRun(this.history, key);
    await this.history.putDocument(fresh, REBASE_MERGE_SKIP, 'skip\n');
    await this.history.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const next = await requireRun(this.history, key);
    next.currentStep = 'code-review';
    next.status = 'waiting';
    next.ownerPid = null;
    next.stepStartedAt = null;
    await this.history.saveRun(next);
    return this.commands.accepted(key, await this.pipeline.startDetached(key));
  }

  private async rebaseWorktrees(run: RunEntity): Promise<Awaited<ReturnType<typeof rebaseFeatureRepos>>> {
    const requirements = await this.history.latestBody(run.key, 'requirements');
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const summary = summaryForBranch(requirements, run.key);
    const names = repoNames((await this.history.latestBody(run.key, 'repos')) ?? '');
    return rebaseFeatureRepos({
      root: this.history.root(),
      key: run.key,
      repos: names,
      branch: branchName(run.key, summary),
      prompt: run.prompt,
      denied: await this.history.listDenyPaths(),
      message: commitMessage(run.key, summary),
      hosts: readEnv(this.config),
    });
  }

  /** Unfinished when this run is still on implement, or no implementation notes were stored. */
  private async checklistUnfinished(run: RunEntity): Promise<boolean> {
    if (run.currentStep === 'implement') {
      return true;
    }
    const notes = (await this.history.latestBody(run.key, 'implementation')) ?? '';
    return notes.trim().length === 0;
  }

  private async startAtImplement(run: RunEntity): Promise<{ http: number; body: { key: string; status: string } }> {
    const phases = await this.history.activePhases(run.id);
    if (!phases.includes('implementation')) {
      await this.history.noteFlow(run.key, ['implementation', 'code-review', 'ci'], 'implement');
    }
    const fresh = await requireRun(this.history, run.key);
    fresh.currentStep = 'implement';
    fresh.status = 'waiting';
    fresh.ownerPid = null;
    fresh.stepStartedAt = null;
    await this.history.saveRun(fresh);
    return this.commands.accepted(run.key, await this.pipeline.startDetached(run.key));
  }
}

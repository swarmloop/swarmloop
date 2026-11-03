import { ConflictException, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { root } from '../history/run-paths';
import { PipelineService } from '../pipeline/pipeline.service';
import { branchName, commitMessage, summaryForBranch } from '../steps/branch/branch-name';
import { REBASE_MERGE_SKIP } from '../steps/merge-request/merge-request.step';
import { REBASE_CONFLICT, rebaseFeatureRepos } from '../git/rebase-worktree';
import { repoNames } from '../steps/shared/repo-names';
import { SwarmloopError } from '../core/swarmloop-error';
import { RunRef } from '../contract/api';
import { RunCommandsService } from './run-commands.service';
import { requireRun } from './run-queries.service';

@Injectable()
export class RunRebaseService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly flows: FlowRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly pipeline: PipelineService,
    private readonly config: AppConfig,
    private readonly commands: RunCommandsService,
    private readonly clock: Clock,
  ) {}

  async rebase(key: string): Promise<RunRef> {
    const run = await requireRun(this.runs, key);
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
      await this.documents.putDocument(run, REBASE_CONFLICT, unfinished ? 'pending-implement\n' : 'pending\n');
      return this.startAtImplement(run);
    }
    if (await this.checklistUnfinished(run)) {
      return this.startAtImplement(run);
    }
    if (status === 'failed' || status === 'waiting') {
      return this.commands.resume(key);
    }
    const fresh = await requireRun(this.runs, key);
    await this.documents.putDocument(fresh, REBASE_MERGE_SKIP, 'skip\n');
    await this.flows.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const next = await requireRun(this.runs, key);
    next.currentStep = 'code-review';
    next.status = 'waiting';
    next.ownerPid = null;
    next.stepStartedAt = null;
    await this.runs.saveRun(next);
    return this.commands.accepted(key, await this.pipeline.startDetached(key));
  }

  private async rebaseWorktrees(run: RunEntity): Promise<Awaited<ReturnType<typeof rebaseFeatureRepos>>> {
    const requirements = await this.documents.latestBody(run.key, 'requirements');
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const summary = summaryForBranch(requirements, run.key);
    const names = repoNames((await this.documents.latestBody(run.key, 'repos')) ?? '');
    return rebaseFeatureRepos({
      root: root(this.config),
      key: run.key,
      repos: names,
      branch: branchName(run.key, summary),
      prompt: run.prompt,
      denied: await this.checkouts.listDenyPaths(),
      message: commitMessage(run.key, summary),
      hosts: { ...this.config.env, clock: this.clock },
    });
  }

  /** Unfinished when this run is still on implement, or no implementation notes were stored. */
  private async checklistUnfinished(run: RunEntity): Promise<boolean> {
    if (run.currentStep === 'implement') {
      return true;
    }
    const notes = (await this.documents.latestBody(run.key, 'implementation')) ?? '';
    return notes.trim().length === 0;
  }

  private async startAtImplement(run: RunEntity): Promise<RunRef> {
    const phases = await this.flows.activePhases(run.id);
    if (!phases.includes('implementation')) {
      await this.flows.noteFlow(run.key, ['implementation', 'code-review', 'ci'], 'implement');
    }
    const fresh = await requireRun(this.runs, run.key);
    fresh.currentStep = 'implement';
    fresh.status = 'waiting';
    fresh.ownerPid = null;
    fresh.stepStartedAt = null;
    await this.runs.saveRun(fresh);
    return this.commands.accepted(run.key, await this.pipeline.startDetached(run.key));
  }
}

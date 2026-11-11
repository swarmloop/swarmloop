import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import type { SandboxMount } from '../core/sandbox-mount';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { root } from '../history/run-paths';
import { branchName, commitMessage, summaryForBranch } from './branch/branch-name';
import { completeRebase, rebaseFeatureRepos } from '../git/rebase';
import { repoNames } from '../git/repo-names';
import { SwarmloopError } from '../core/swarmloop-error';
import { mountsForStep } from '../git/repo-names';
import { ARTIFACTS } from './contract/artifacts';
import { ERROR_CODES } from '../contract/error-codes';
import { writeRunState } from '../history/run-state';
import { MergeRequestDrafts } from './merge-request/merge-request-draft';
import { runJournal } from './shared/rebase-journal';
import type { RebaseJournal } from '../git/rebase';

/** The steps that read a review or a CI result. */
const AFTER_REVIEW: readonly string[] = ['commit', 'merge-request', 'pipeline'];

export abstract class RunRebaseEnvironment {
  abstract refreshAfterRebase(
    run: RunEntity,
    mounts: SandboxMount[],
    bases: ReadonlyMap<string, string>,
  ): Promise<void>;
}

@Injectable()
export class RunRebase {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly flows: FlowRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly environments: RunRebaseEnvironment,
    private readonly drafts: MergeRequestDrafts,
  ) {}

  /** A reconciler resume of an unfinished journal is not a new command: it does not raise the generation. */
  async rebase(key: string, resume = false): Promise<'resume' | 'start'> {
    const run = await this.requireRun(key);
    if (run.status !== 'failed' && run.status !== 'done' && run.status !== 'waiting') {
      throw new ConflictException(`${key} is ${run.status}`);
    }
    const status = run.status;
    if (!resume) {
      await this.assertSubtasksIdle(run);
      await this.turnBackToDraft(run);
      await this.runs.bumpGeneration(key);
    }
    const journal = runJournal(this.documents, await this.requireRun(key));
    let stop: Awaited<ReturnType<typeof rebaseFeatureRepos>>;
    const bases = new Map<string, string>();
    try {
      stop = await this.rebaseWorktrees(run, bases, journal);
      const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
      await this.environments.refreshAfterRebase(
        run,
        mountsForStep(root(this.config), run.key, names, run.targetPath),
        bases,
      );
      await completeRebase(journal);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'rebase failed';
      throw new ConflictException(message);
    }
    if (stop.kind === 'conflict') {
      const unfinished = await this.checklistUnfinished(run);
      await this.documents.putDocument(
        run,
        ARTIFACTS.rebaseConflict.kind,
        unfinished ? 'pending-implement\n' : 'pending\n',
      );
      return this.startAtImplement(run);
    }
    if (await this.checklistUnfinished(run)) {
      return this.startAtImplement(run);
    }
    if (status === 'done') {
      await this.documents.putDocument(await this.requireRun(key), ARTIFACTS.rebaseMergeSkip.kind, 'skip\n');
      return this.startAtReview(key);
    }
    // Every review and CI result of the old generation is stale: a step that reads them goes back through code-review.
    return AFTER_REVIEW.includes(run.currentStep) ? this.startAtReview(key) : 'resume';
  }

  private async turnBackToDraft(run: RunEntity): Promise<void> {
    try {
      await this.drafts.backToDraft(run);
    } catch (error) {
      throw new ConflictException(error instanceof SwarmloopError ? error.message : 'merge request failed');
    }
  }

  /** The feature branch moves under a subtask that works on it: a Rebase waits until none runs. */
  private async assertSubtasksIdle(run: RunEntity): Promise<void> {
    if (!run.split) return;
    const working = (await this.runs.children(run)).some(
      (child) => child.status === 'running' || this.runs.held(child),
    );
    if (working) throw new ConflictException(ERROR_CODES.SUBTASKS_RUNNING);
  }

  private async startAtReview(key: string): Promise<'start'> {
    await this.flows.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const next = await this.requireRun(key);
    writeRunState(next, { status: 'waiting', currentStep: 'code-review' });
    next.stepStartedAt = null;
    await this.runs.saveRun(next);
    return 'start';
  }

  private async rebaseWorktrees(
    run: RunEntity,
    bases: Map<string, string>,
    journal: RebaseJournal,
  ): Promise<Awaited<ReturnType<typeof rebaseFeatureRepos>>> {
    const requirements = await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind);
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const summary = summaryForBranch(requirements, run.key);
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    return rebaseFeatureRepos({
      root: root(this.config),
      key: run.key,
      repos: names,
      branch: branchName(run.key, summary),
      prompt: run.prompt,
      denied: await this.checkouts.listDenyPaths(),
      message: commitMessage(run.key, summary),
      hosts: { ...this.config.env, clock: this.clock },
      journal,
      onBase: (repo, sha) => {
        bases.set(repo, sha);
      },
    });
  }

  /** Unfinished when this run is still on implement, or no implementation notes were stored. */
  private async checklistUnfinished(run: RunEntity): Promise<boolean> {
    if (run.currentStep === 'implement') {
      return true;
    }
    const notes = (await this.documents.latestBody(run.key, ARTIFACTS.implementation.kind)) ?? '';
    return notes.trim().length === 0;
  }

  private async startAtImplement(run: RunEntity): Promise<'start'> {
    const phases = await this.flows.activePhases(run.id);
    if (!phases.includes('implementation')) {
      await this.flows.noteFlow(run.key, ['implementation', 'checks', 'code-review', 'ci'], 'implement');
    }
    const fresh = await this.requireRun(run.key);
    writeRunState(fresh, { status: 'waiting', currentStep: 'implement' });
    fresh.stepStartedAt = null;
    await this.runs.saveRun(fresh);
    return 'start';
  }

  private async requireRun(key: string): Promise<RunEntity> {
    const run = await this.runs.findRun(key);
    if (!run) throw new NotFoundException(`${key} is missing`);
    return run;
  }
}

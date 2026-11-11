import { existsSync } from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { fetchBranch } from '../git/rebase';
import { originRef } from '../git/base-ref';
import { git } from '../git/git';
import { repoNames, worktreePath } from '../git/repo-names';
import { root } from '../history/run-paths';
import { parseMergeRequests } from '../steps/merge-request/merge-request-record';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import { isSubtask, parseSubtasks, settled, SUBTASKS_KIND, type Subtask } from '../contract/subtask';
import { SubtaskOps, type SubtaskMergeRequest } from '../steps/shared/subtask-ops';
import { DocumentRepository } from '../history/document.repository';
import { CommandService } from './command.service';

/** What the api layer does for the subtasks of a parent. It registers itself at init, so `pipeline` never imports `api`. */
interface SubtaskStarter {
  /** The waiting run of a task. It has no worktree until it starts. */
  open(parent: RunEntity, task: Subtask): Promise<RunEntity>;
  /** Starts the run of a task that `open` made. */
  launch(parent: RunEntity, task: Subtask): Promise<void>;
}

/** The shared operations on the subtask runs of a parent. Each one goes through the command door. */
@Injectable()
export class SubtaskPort extends SubtaskOps {
  private readonly logger = new Logger(SubtaskPort.name);
  private starter: SubtaskStarter | null = null;

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
  }

  register(starter: SubtaskStarter): void {
    this.starter = starter;
  }

  open(parent: RunEntity, task: Subtask): Promise<RunEntity> {
    return this.started().open(parent, task);
  }

  launch(parent: RunEntity, task: Subtask): Promise<void> {
    return this.started().launch(parent, task);
  }

  override find(parent: RunEntity, taskId: string): Promise<RunEntity | null> {
    return this.runs.findSubtask(parent, taskId);
  }

  override async waitFor(run: RunEntity, message: string): Promise<void> {
    const reason = { code: ERROR_CODES.SUBTASK_WAITING, message };
    if (run.status !== 'waiting' || JSON.stringify(deriveState(run).reason) === JSON.stringify(reason)) return;
    writeRunState(run, { status: 'waiting', reason });
    await this.runs.saveRun(run);
  }

  override async withoutCi(run: RunEntity): Promise<boolean> {
    return ((await this.documents.latestBody(run.key, 'pipeline_log')) ?? '').startsWith('result: none');
  }

  override async resume(run: RunEntity): Promise<void> {
    await this.commands.accept('resume', run.key, {}, { idempotencyKey: `subtasks-resume-${run.revision}` });
  }

  override async mergeRequests(run: RunEntity): Promise<SubtaskMergeRequest[]> {
    const body = await this.documents.latestBody(run.key, ARTIFACTS.mergeRequest.kind);
    if (!body?.trim()) return [];
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    return parseMergeRequests(body).map((record, index) => ({
      repo: names[index] ?? record.project,
      project: record.project,
      iid: record.iid,
    }));
  }

  override async branchOf(run: RunEntity): Promise<string> {
    const requirements = (await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind)) ?? '';
    return branchName(run.key, summaryForBranch(requirements, run.key));
  }

  override async fastForward(parent: RunEntity): Promise<void> {
    const branch = await this.branchOf(parent);
    const names = repoNames((await this.documents.latestBody(parent.key, ARTIFACTS.repos.kind)) ?? '');
    for (const repo of names) {
      const path = worktreePath(root(this.config), parent.key, repo);
      if (existsSync(path) && (await fetchBranch(path, repo, branch, { ...this.config.env, clock: this.clock }))) {
        await git(['-C', path, 'merge', '--ff-only', originRef(branch)]);
      }
    }
  }

  override async rebase(run: RunEntity): Promise<void> {
    if (!['failed', 'done', 'waiting'].includes(run.status) || (await this.mergeRequests(run)).length === 0) return;
    try {
      await this.commands.accept(
        'rebase',
        run.key,
        {},
        { idempotencyKey: `subtask-rebase-${run.revision}-${run.generation}` },
      );
    } catch (error) {
      this.logger.warn(`${run.key} was not rebased: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sends a Rebase to every subtask of the parent that is not merged or skipped. */
  async rebaseOpen(parent: RunEntity): Promise<void> {
    const open = parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND)).filter(
      (task) => !settled(task),
    );
    for (const task of open) {
      const child = await this.runs.findSubtask(parent, task.id);
      if (child) await this.rebase(child);
    }
  }

  async stop(run: RunEntity): Promise<void> {
    await this.commands.submit('stop', run.key, {});
  }

  /** Stops every subtask of the parent. A subtask that is not running stays as it is. */
  async stopAll(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      await this.stop(child);
    }
  }

  /** Stops every subtask of the parent and removes its run and worktrees. */
  async removeAll(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      await this.commands.submit('remove', child.key, {});
    }
  }

  /** Sends the parent of a subtask a `resume`, so its next pass sees the subtask as it is now. */
  async notifyParent(key: string): Promise<void> {
    try {
      const run = await this.runs.findRun(key);
      const parent = run && isSubtask(run) ? await this.runs.findById(run.parentRunId as number) : null;
      if (run && parent && this.passDue(parent)) {
        await this.resumeParent(parent, `subtask-${run.key}-${run.revision}`);
      }
    } catch (error) {
      this.logger.warn(`parent of ${key} was not told: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sends `resume` to a parent that waits between passes. A pass that already runs, or is queued, is enough. */
  async resumeParent(parent: RunEntity, idempotencyKey: string): Promise<void> {
    await this.commands.accept('resume', parent.key, {}, { idempotencyKey });
  }

  /** Between passes: the parent waits for its subtasks, or a blocked subtask stopped it. */
  passDue(parent: RunEntity): boolean {
    const { state, reason } = deriveState(parent);
    const code = reason?.code ?? '';
    return (
      parent.currentStep === 'implement' &&
      ((state === 'waiting' && SUBTASK_WAIT_CODES.some((wait) => wait === code)) ||
        (state === 'blocked' && code === ERROR_CODES.SUBTASK_BLOCKED))
    );
  }

  private started(): SubtaskStarter {
    if (!this.starter) {
      throw new Error('subtasks cannot start: no starter is registered');
    }
    return this.starter;
  }
}

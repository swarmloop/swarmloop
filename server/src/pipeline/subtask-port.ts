import { Injectable, Logger } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import { isSubtask, type Subtask } from '../contract/subtask';
import { SubtaskOps } from '../steps/shared/subtask-ops';
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

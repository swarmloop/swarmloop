import type { Logger } from '@nestjs/common';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import { isSubtask } from '../contract/subtask';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import type { VisitRepository } from '../history/visit.repository';
import type { CommandService } from './command.service';
import type { StartGate } from './start-gate';

/** The wake-ups of a split parent and its subtasks: resumes, stops and removes. A resume goes through the start gate as the machine's. */
export class SubtaskWakes {
  constructor(
    private readonly runs: RunRepository,
    private readonly commands: CommandService,
    private readonly gate: StartGate,
    private readonly visits: VisitRepository,
    private readonly logger: Logger,
  ) {}

  /** The machine's resume of a task. A task a person stopped stays stopped: the gate answers `stopped`. */
  async resume(run: RunEntity): Promise<void> {
    await this.gate.resume(run, { by: 'machine', event: `subtasks-resume-${run.revision}` });
  }

  /**
   * A person's Resume of a parent goes on with the tasks that are stopped, as that person's start. The event names the
   * task and its revision, so a later Stop of the task is a new event.
   */
  async resumeStopped(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      if (storedState(child).state !== 'stopped') continue;
      await this.gate.resume(child, { by: 'person', event: `parent-resume-${child.key}-${child.revision}` });
    }
  }

  async stop(run: RunEntity): Promise<void> {
    await this.commands.submit('stop', run.key, {});
  }

  /** Stops every subtask of the parent. A subtask that is not running stays as it is. */
  async stopAll(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      if (storedState(child).state === 'skipped') continue;
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
  async notifyParent(key: string, idempotencyKey?: string): Promise<void> {
    try {
      const run = await this.runs.findRun(key);
      const parent = run && isSubtask(run) ? await this.runs.findById(run.parentRunId as number) : null;
      if (run && parent && this.passDue(parent)) {
        await this.resumeParent(parent, idempotencyKey ?? `subtask-${run.key}-${run.revision}`);
      }
    } catch (error) {
      this.logger.warn(`parent of ${key} was not told: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The key of the wake-up for a subtask that is `blocked` or `failed` and is about to leave that state; null for any other run. */
  async leavingKey(key: string): Promise<string | null> {
    const run = await this.runs.findRun(key);
    if (!run || !isSubtask(run) || !['blocked', 'failed'].includes(storedState(run).state)) return null;
    return `subtask-left-${run.key}-${(await this.visits.listStats(run.id)).length}`;
  }

  /** Sends `resume` to a parent that waits between passes. A pass that already runs, or is queued, is enough. */
  async resumeParent(parent: RunEntity, idempotencyKey: string): Promise<void> {
    await this.gate.resume(parent, { by: 'machine', event: idempotencyKey });
  }

  /** A split parent in implement with subtask runs: a pass that already runs, or is queued, is enough for a resume. */
  async hasPass(key: string): Promise<boolean> {
    const run = await this.runs.findRun(key);
    return !!run?.split && run.currentStep === 'implement' && (await this.runs.children(run)).length > 0;
  }

  /** Between passes: the parent waits for its subtasks, or a blocked subtask stopped it. */
  passDue(parent: RunEntity): boolean {
    const { state, reason } = storedState(parent);
    const code = reason?.code ?? '';
    return (
      parent.currentStep === 'implement' &&
      ((state === 'waiting' && SUBTASK_WAIT_CODES.some((wait) => wait === code)) ||
        (state === 'blocked' && code === ERROR_CODES.SUBTASK_BLOCKED))
    );
  }
}

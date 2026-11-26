import { ConflictException, Injectable } from '@nestjs/common';
import { isHostOutage } from '../core/swarmloop-error';
import { RunRef } from '../contract/api';
import { RunRepository } from '../history/run.repository';
import { WorkspaceGuard } from '../pipeline/workspace-guard';
import { PipelineService } from '../pipeline/pipeline.service';
import { RunRebase } from '../steps/run-rebase';
import { EpicTasksMove } from '../steps/shared/epic-tasks-move';
import { RunCommandsService } from './run-commands.service';

type RebaseNext = 'resume' | 'start' | 'stay' | 'resolve';

const MACHINE = { by: 'machine', level: null } as const;

@Injectable()
export class RunRebaseService {
  constructor(
    private readonly action: RunRebase,
    private readonly pipeline: PipelineService,
    private readonly commands: RunCommandsService,
    private readonly runs: RunRepository,
    private readonly workspace: WorkspaceGuard,
    private readonly tasksMove: EpicTasksMove,
  ) {}

  /**
   * `main` is the machine bringing a new green main into an epic: its open subtasks follow the epic's new tip.
   * `keepsWait` is a parent moving a subtask that waits on a question or a sibling: it is moved and starts nothing.
   */
  async rebase(key: string, byParent = false, main?: string, keepsWait = false): Promise<RunRef> {
    // A cleaned run gets its worktrees back before they are rebased.
    const run = await this.runs.findRun(key);
    if (run) await this.workspace.ensureForRequest(run);
    const next = await this.rebaseOrConflict(key, byParent, main !== undefined, keepsWait);
    // An epic whose rebase conflicted moves none: the end of its resolution round moves them.
    if (run?.split && next !== 'resolve') await this.tasksMove.move(run);
    if (next === 'stay') return { key, status: keepsWait ? 'waiting' : 'blocked' };
    // A parent's or main's rebase of an idle task is the machine's start; a person's rebase keeps the default.
    const machine = byParent || main !== undefined;
    if (next === 'resume') return this.commands.resume(key, undefined, machine ? MACHINE : undefined);
    return this.commands.accepted(
      key,
      await (machine ? this.pipeline.startDetached(key, { startBy: MACHINE.by }) : this.pipeline.startDetached(key)),
    );
  }

  /** A person who asks for a Rebase while the host is down gets the plain reason; the automatic callers get the outage itself. */
  private async rebaseOrConflict(
    key: string,
    byParent: boolean,
    byMain: boolean,
    keepsWait: boolean,
  ): Promise<RebaseNext> {
    try {
      return await this.action.rebase(key, false, byParent, byMain, keepsWait);
    } catch (error) {
      if (isHostOutage(error) && !byMain) throw new ConflictException(error.message);
      throw error;
    }
  }
}

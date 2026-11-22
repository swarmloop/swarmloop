import { ConflictException, Injectable } from '@nestjs/common';
import { HostUnavailable } from '../core/swarmloop-error';
import { RunRef } from '../contract/api';
import { RunRepository } from '../history/run.repository';
import { WorkspaceGuard } from '../pipeline/workspace-guard';
import { SubtaskPort } from '../pipeline/subtask-port';
import { PipelineService } from '../pipeline/pipeline.service';
import { RunRebase } from '../steps/run-rebase';
import { RunCommandsService } from './run-commands.service';

const MACHINE = { by: 'machine', level: null } as const;

@Injectable()
export class RunRebaseService {
  constructor(
    private readonly action: RunRebase,
    private readonly pipeline: PipelineService,
    private readonly commands: RunCommandsService,
    private readonly runs: RunRepository,
    private readonly workspace: WorkspaceGuard,
    private readonly subtasks: SubtaskPort,
  ) {}

  async rebase(key: string, byParent = false): Promise<RunRef> {
    // A cleaned run gets its worktrees back before they are rebased.
    const run = await this.runs.findRun(key);
    if (run) await this.workspace.ensureForRequest(run);
    const next = await this.rebaseOrConflict(key, byParent);
    if (run?.split) await this.subtasks.rebaseOpen(run);
    if (next === 'stay') return { key, status: 'blocked' };
    // A parent's rebase of an idle task is the machine's start; a person's rebase keeps the default.
    if (next === 'resume') return this.commands.resume(key, undefined, byParent ? MACHINE : undefined);
    return this.commands.accepted(
      key,
      await (byParent ? this.pipeline.startDetached(key, { startBy: MACHINE.by }) : this.pipeline.startDetached(key)),
    );
  }

  /** A person who asks for a Rebase while the host is down gets the plain reason; the automatic callers get the outage itself. */
  private async rebaseOrConflict(key: string, byParent: boolean): Promise<'resume' | 'start' | 'stay'> {
    try {
      return await this.action.rebase(key, false, byParent);
    } catch (error) {
      if (error instanceof HostUnavailable) throw new ConflictException(error.message);
      throw error;
    }
  }
}

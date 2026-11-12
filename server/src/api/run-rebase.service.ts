import { ConflictException, Injectable } from '@nestjs/common';
import { HostUnavailable } from '../core/swarmloop-error';
import { RunRef } from '../contract/api';
import { RunRepository } from '../history/run.repository';
import { WorkspaceGuard } from '../pipeline/workspace-guard';
import { SubtaskPort } from '../pipeline/subtask-port';
import { PipelineService } from '../pipeline/pipeline.service';
import { RunRebase } from '../steps/run-rebase';
import { RunCommandsService } from './run-commands.service';

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

  async rebase(key: string): Promise<RunRef> {
    // A cleaned run gets its worktrees back before they are rebased.
    const run = await this.runs.findRun(key);
    if (run) await this.workspace.ensureForRequest(run);
    const next = await this.rebaseOrConflict(key);
    if (run?.split) await this.subtasks.rebaseOpen(run);
    if (next === 'resume') return this.commands.resume(key);
    return this.commands.accepted(key, await this.pipeline.startDetached(key));
  }

  /** A person who asks for a Rebase while the host is down gets the plain reason; the automatic callers get the outage itself. */
  private async rebaseOrConflict(key: string): Promise<'resume' | 'start'> {
    try {
      return await this.action.rebase(key);
    } catch (error) {
      if (error instanceof HostUnavailable) throw new ConflictException(error.message);
      throw error;
    }
  }
}

import { Injectable } from '@nestjs/common';
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
    const next = await this.action.rebase(key);
    if (run?.split) await this.subtasks.rebaseOpen(run);
    if (next === 'resume') return this.commands.resume(key);
    return this.commands.accepted(key, await this.pipeline.startDetached(key));
  }
}

import { ConflictException, Injectable } from '@nestjs/common';
import { HostUnavailable } from '../core/swarmloop-error';
import { RunRef } from '../contract/api';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { WorkspaceGuard } from '../pipeline/workspace-guard';
import { SubtaskPort } from '../pipeline/subtask-port';
import { PipelineService } from '../pipeline/pipeline.service';
import { RunRebase } from '../steps/run-rebase';
import { mainMovedNote } from '../steps/implement/split-rebase';
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
    private readonly subtasks: SubtaskPort,
  ) {}

  /** `main` is the machine bringing a new green main into an epic: its open subtasks follow the epic's new tip. */
  async rebase(key: string, byParent = false, main?: string): Promise<RunRef> {
    // A cleaned run gets its worktrees back before they are rebased.
    const run = await this.runs.findRun(key);
    if (run) await this.workspace.ensureForRequest(run);
    const next = await this.rebaseOrConflict(key, byParent, main !== undefined);
    if (run?.split) await this.moveSubtasks(run, next, main);
    if (next === 'stay') return { key, status: 'blocked' };
    // A parent's or main's rebase of an idle task is the machine's start; a person's rebase keeps the default.
    const machine = byParent || main !== undefined;
    if (next === 'resume') return this.commands.resume(key, undefined, machine ? MACHINE : undefined);
    return this.commands.accepted(
      key,
      await (machine ? this.pipeline.startDetached(key, { startBy: MACHINE.by }) : this.pipeline.startDetached(key)),
    );
  }

  /**
   * A person's Rebase sends each open subtask a plain rebase; a main move names the epic's new tip and says why.
   * An epic whose rebase conflicted moves none: the end of its resolution round moves them.
   */
  private async moveSubtasks(run: RunEntity, next: RebaseNext, main?: string): Promise<void> {
    if (next === 'resolve') return;
    if (main === undefined) return this.subtasks.rebaseOpen(run);
    await this.subtasks.rebaseOpen(run, { tip: await this.action.tipOf(run.key), note: mainMovedNote(main) });
  }

  /** A person who asks for a Rebase while the host is down gets the plain reason; the automatic callers get the outage itself. */
  private async rebaseOrConflict(key: string, byParent: boolean, byMain: boolean): Promise<RebaseNext> {
    try {
      return await this.action.rebase(key, false, byParent, byMain);
    } catch (error) {
      if (error instanceof HostUnavailable && !byMain) throw new ConflictException(error.message);
      throw error;
    }
  }
}

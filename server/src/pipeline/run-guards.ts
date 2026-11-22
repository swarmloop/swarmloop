import { Injectable } from '@nestjs/common';
import type { StepName } from '../contract/steps';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { SpendLimit } from '../steps/shared/spend-limit';
import { DiskGuard } from './disk-guard';
import { WorkspaceGuard, workspaceBlock } from './workspace-guard';

/** What stops a step from starting: the spend and token limits, then a workspace or disk that cannot be made ready. */
@Injectable()
export class RunGuards {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly limit: SpendLimit,
    private readonly workspace: WorkspaceGuard,
    private readonly disk: DiskGuard,
  ) {}

  /** Why the step may not start on the limits, or null. Only the run recorded `running` on the step continues past them. */
  spendStop(key: string, step: StepName): Promise<string | null> {
    return this.limit.spendStop(key, step);
  }

  /** Releases the run blocked on a step, with the reason a person reads. */
  block(run: RunEntity, step: StepName, code: string, message: string): Promise<void> {
    return this.limit.block(run, step, code, message);
  }

  /** Why a step may not start: the limits first, then a workspace or disk that cannot be made ready. */
  async stopBefore(key: string, step: StepName): Promise<string | null> {
    return (await this.spendStop(key, step)) ?? this.workspaceStop(key, step);
  }

  /**
   * Brings the worktrees of the run back and checks the disk, before the step mounts anything. A run that cannot
   * go on is blocked on the step it was about to start, and the message says why.
   */
  async workspaceStop(key: string, step: StepName): Promise<string | null> {
    const run = step === 'done' ? null : await this.runs.findRun(key);
    if (!run) {
      return null;
    }
    try {
      await this.workspace.ensure(run);
      await this.disk.check(run, step);
      return null;
    } catch (error) {
      const block = workspaceBlock(error);
      if (!block) {
        throw error;
      }
      await this.block(run, step, block.code, block.message);
      await this.documents.putDocument(run, 'error', `${block.message}\n`);
      return block.message;
    }
  }
}

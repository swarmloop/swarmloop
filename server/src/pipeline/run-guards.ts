import { Injectable } from '@nestjs/common';
import { overSpend } from '../agent/limits';
import { AppConfig } from '../config/env';
import { ERROR_CODES } from '../contract/error-codes';
import type { StepName } from '../contract/steps';
import { continuesSameStep } from '../core/pipeline-result';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { DiskGuard } from './disk-guard';
import { WorkspaceGuard, workspaceBlock } from './workspace-guard';

/** What stops a step from starting: the spend and token limits, then a workspace or disk that cannot be made ready. */
@Injectable()
export class RunGuards {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly config: AppConfig,
    private readonly workspace: WorkspaceGuard,
    private readonly disk: DiskGuard,
  ) {}

  /** Why the step may not start on the limits, or null. Only the run recorded `running` on the step continues past them. */
  async spendStop(key: string, step: StepName): Promise<string | null> {
    const existing = await this.runs.findRun(key);
    if (!existing || continuesSameStep(existing.status, existing.currentStep, step)) {
      return null;
    }
    const why = await this.overLimit(existing);
    if (!why) {
      return null;
    }
    const message = `${key} is over the spend limit. ${step} was not started`;
    await this.documents.putDocument(existing, 'spend', `${message}\n`);
    if (existing.status !== 'done') {
      await this.block(existing, step, ERROR_CODES.SPEND_LIMIT, why);
    }
    return message;
  }

  /** The words a person reads for the limit the run is over, or null when it is under both. */
  private async overLimit(run: RunEntity): Promise<string | null> {
    const { MAX_RUN_USD, MAX_RUN_TOKENS } = this.config.env;
    if (overSpend(run.spentUsd, MAX_RUN_USD)) {
      return `spent $${run.spentUsd.toFixed(2)} of MAX_RUN_USD $${MAX_RUN_USD.toFixed(2)}; raise MAX_RUN_USD, then Resume`;
    }
    if (MAX_RUN_TOKENS === null) {
      return null;
    }
    const used = await this.visits.tokenTotal(run.id);
    return used >= MAX_RUN_TOKENS
      ? `used ${used} tokens of MAX_RUN_TOKENS ${MAX_RUN_TOKENS}; raise MAX_RUN_TOKENS, then Resume`
      : null;
  }

  /** Releases the run blocked on a step, with the reason a person reads. */
  async block(run: RunEntity, step: StepName, code: string, message: string): Promise<void> {
    await this.runs.release(run, {
      status: 'blocked',
      currentStep: step,
      reason: { code, message },
      stepStartedAt: null,
    });
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

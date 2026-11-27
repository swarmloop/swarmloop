import { Injectable } from '@nestjs/common';
import { overSpend } from '../../agent/limits';
import { AppConfig } from '../../config/env';
import { ERROR_CODES } from '../../contract/error-codes';
import type { StepName } from '../../contract/steps';
import { continuesSameStep } from '../../core/pipeline-result';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';

/** The spend limit of a run, its one budget: whether a step may start, and the block a start over the limit leaves. */
@Injectable()
export class SpendLimit {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly calls: AgentCallRepository,
    private readonly config: AppConfig,
  ) {}

  /** Why the step may not start on the spend limit, or null. Only the run recorded `running` on the step continues past it. */
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

  /** The words a person reads when the run is over MAX_RUN_USD, its one budget, or null when it is under. The sum is the log's. */
  async overLimit(run: Pick<RunEntity, 'id'>): Promise<string | null> {
    const { MAX_RUN_USD } = this.config.env;
    const stored = await this.runs.findById(run.id);
    if (!stored) {
      return null;
    }
    const spent = await this.calls.spendOfRun(stored.key);
    return overSpend(spent, MAX_RUN_USD)
      ? `spent $${spent.toFixed(2)} of MAX_RUN_USD $${MAX_RUN_USD.toFixed(2)}. Resume runs the step past the limit; a higher MAX_RUN_USD lets the run go on by itself`
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
}

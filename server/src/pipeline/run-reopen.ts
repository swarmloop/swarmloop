import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../contract/error-codes';
import { HostUnavailable } from '../core/swarmloop-error';
import type { PipelineResult } from '../core/pipeline-result';
import { RunRepository } from '../history/run.repository';
import { deriveState } from '../history/run-state';
import { MergeRequestDrafts } from '../steps/merge-request/merge-request-draft';

/** Gives a done run back to the flow when the planner changed its plan: plan-improve checks the plan, and the work goes on. */
@Injectable()
export class RunReopen {
  constructor(
    private readonly runs: RunRepository,
    private readonly drafts: MergeRequestDrafts,
  ) {}

  /**
   * Reopens a done run at plan-improve and starts the pipeline there through `start`. Its merge requests go back to
   * draft; a code host that does not answer makes the run wait for the next try. A run that is not done, and one that is merged, closed or removed, is left as it is.
   */
  async reopen(key: string, start: (key: string) => Promise<PipelineResult>): Promise<PipelineResult> {
    const run = await this.runs.findRun(key);
    if (!run || run.workspace === 'removed' || deriveState(run).state !== 'done') {
      return { exitCode: 0, message: `${key} is left as it is` };
    }
    // The run leaves `done` first, so the revised plan is never left on a finished run.
    const reopened = await this.runs.release(run, { status: 'waiting', currentStep: 'plan-improve' });
    try {
      await this.drafts.backToDraft(reopened);
    } catch (error) {
      if (!(error instanceof HostUnavailable)) throw error;
      // A code host that does not answer is a wait: the reconciler goes on at plan-improve at `retryAt`.
      await this.runs.release(reopened, {
        status: 'waiting',
        reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: error.message, retryAt: error.retryAt },
        stepStartedAt: null,
      });
      return { exitCode: 1, message: error.message };
    }
    return start(key);
  }
}

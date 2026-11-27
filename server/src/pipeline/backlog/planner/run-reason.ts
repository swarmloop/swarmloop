import { Injectable } from '@nestjs/common';
import { resultLine } from '../../../contract/event-text';
import { REASON } from '../../../contract/run-state';
import type { RunEntity } from '../../../history/entities';
import { storedState } from '../../../history/run-state';
import { StepEventLog } from '../../../history/step-event.log';

/** Why a failed or blocked run stands still, in the words the planner reads. */
@Injectable()
export class RunReasons {
  constructor(private readonly events: StepEventLog) {}

  /**
   * The run's stored state reason, or else the last line of the result its current step ended with, as the run page
   * reads it. A plain block, which stores only the generic code, has no reason of its own. Null for a run that is
   * neither failed nor blocked, or that gives no reason.
   */
  async of(run: RunEntity): Promise<string | null> {
    const { state, reason } = storedState(run);
    if (state !== 'failed' && state !== 'blocked') return null;
    if (reason && reason.code !== REASON.blocked) return `${reason.code}: ${reason.message}`;
    const end = await this.events.lastEnd(run.id, run.currentStep);
    const line = end ? resultLine(end.summary) : '';
    return line ? `${run.currentStep} step: ${line}` : null;
  }
}

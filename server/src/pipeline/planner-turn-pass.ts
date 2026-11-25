import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import { ERROR_CODES } from '../contract/error-codes';
import { HostUnavailable } from '../core/swarmloop-error';
import { REASON } from '../contract/run-state';
import type { StepName } from '../contract/steps';
import type { RunRepository } from '../history/run.repository';
import type { AgentDoor } from '../steps/shared/agent-door';
import type { ChainRefusal } from '../steps/shared/start-refused';
import type { HopGate } from './hop-gate';
import type { PlannerTurns } from './planner-turns';

/** What the pass leaves the drive: the step to go on from, the options of a start a planner made possible, or the end. */
type TurnPassResult = { step: StepName } | { again: StepOptions } | { message: string } | null;

/**
 * Between two steps, the planner takes what waits for it, one turn at a time in the order it came: a person's message,
 * and the question of a step that waits for the answer. A plan a message changed goes to plan-improve, and the flow
 * goes on from there as after any return. Otherwise the run goes on as it was. A turn the door refuses for the same
 * input leaves the run waiting and asks the planners' chain one level above the planner whose turn was refused.
 */
export class PlannerTurnPass {
  constructor(
    private readonly runs: RunRepository,
    private readonly turns: PlannerTurns | undefined,
    private readonly door: AgentDoor,
    private readonly hop: HopGate,
    private readonly planStep: (key: string) => Promise<PipelineResult>,
  ) {}

  async run(key: string, declined: Set<string>): Promise<TurnPassResult> {
    const run = await this.runs.findRun(key);
    const turns = this.turns;
    if (!run || !turns) return null;
    for (let next = await turns.next(run, declined); next; next = await turns.next(run, declined)) {
      if (next === 'question' || next === 'answer') {
        this.door.takeRefusal(key);
        try {
          if (next === 'question') await turns.answer(key, declined);
          else await turns.settle(key, declined);
        } catch (error) {
          if (error instanceof HostUnavailable) return this.hostDown(key, error);
          throw error;
        }
        const refusal = this.door.takeRefusal(key);
        if (refusal) return this.refused(key, refusal);
        continue;
      }
      const outcome = await turns.take(key, () => this.planStep(key), declined);
      if (outcome === 'none') return null;
      if (outcome === 'changed') {
        const fresh = await this.runs.findRun(key);
        if (fresh) await this.runs.release(fresh, { status: 'waiting', currentStep: 'plan-improve' });
        return { step: 'plan-improve' };
      }
    }
    return null;
  }

  /** The model host did not answer: the run waits for its next try, the question stays pending for the host resume. */
  private async hostDown(key: string, error: HostUnavailable): Promise<TurnPassResult> {
    const run = await this.runs.findRun(key);
    if (run?.status === 'waiting') {
      await this.runs.release(run, {
        status: 'waiting',
        reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: error.message, retryAt: error.retryAt },
        stepStartedAt: null,
      });
    }
    return { message: error.message };
  }

  /** The run waits with the same-input reason, and the chain is asked at the refusal's level. */
  private async refused(key: string, refusal: ChainRefusal): Promise<TurnPassResult> {
    const run = await this.runs.findRun(key);
    if (run?.status === 'waiting') {
      await this.runs.release(run, {
        status: 'waiting',
        reason: { code: REASON.sameInput, message: refusal.message },
        stepStartedAt: null,
      });
    }
    return this.hop.askChain(key, refusal);
  }
}

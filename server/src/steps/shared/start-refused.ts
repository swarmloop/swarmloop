import { ERROR_CODES } from '../../contract/error-codes';
import { REASON } from '../../contract/run-state';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { Route } from '../contract/step-contract';
import type { ChainQuestion } from './subtask-ops';

/** The words a person reads when write tools are asked for outside a step's visit. */
export const WRITE_REFUSAL = "Code is written only in a step: write to the run's planner.";

/** What a refused start puts up the planners' chain, and the line the run page shows meanwhile. */
export interface ChainRefusal {
  message: string;
  /** The refusal line and the step's last words whole. */
  question: ChainQuestion;
  /** The level of the planner the question starts at: 0 for the machine, one above the planner that asked. */
  startLevel: number;
}

/** What the door says when it does not start an agent: write tools outside a step, a limit, or the same input again. */
export class StartRefused extends SwarmloopError {
  /** The code the run waits or is blocked with: a limit's error code, or the same-input reason. Null for write tools. */
  readonly reasonCode: typeof ERROR_CODES.SPEND_LIMIT | typeof REASON.sameInput | null;
  readonly question?: ChainQuestion;
  readonly startLevel?: number;

  private constructor(
    readonly kind: 'write' | 'limit' | 'same-input',
    message: string,
    reasonCode: StartRefused['reasonCode'],
    again?: ChainRefusal,
  ) {
    super(message, {
      code: reasonCode === ERROR_CODES.SPEND_LIMIT ? ERROR_CODES.SPEND_LIMIT : undefined,
      category: 'user',
    });
    this.name = 'StartRefused';
    this.reasonCode = reasonCode;
    this.question = again?.question;
    this.startLevel = again?.startLevel;
  }

  static write(): StartRefused {
    return new StartRefused('write', WRITE_REFUSAL, null);
  }

  static limit(message: string): StartRefused {
    return new StartRefused('limit', message, ERROR_CODES.SPEND_LIMIT);
  }

  static sameInput(refusal: ChainRefusal): StartRefused {
    return new StartRefused('same-input', refusal.message, REASON.sameInput, refusal);
  }
}

/** The route a step takes when the door refused its start. Write tools are no step's route: the caller's code is wrong. */
export function refusedRoute(error: StartRefused): Route {
  if (error.kind === 'limit') return { to: 'block', code: ERROR_CODES.SPEND_LIMIT, reason: error.message };
  if (error.kind === 'same-input') return { to: 'wait', code: REASON.sameInput, reason: error.message };
  throw error;
}

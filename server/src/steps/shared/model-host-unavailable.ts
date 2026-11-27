import { ERROR_CODES } from '../../contract/error-codes';
import { nextTryAt } from '../../contract/outside-waits';
import { HostUnavailable } from '../../core/swarmloop-error';
import { HOST_RETRY_MS } from '../../integrations/http';
import type { ModelHostOutage } from '../../integrations/agent-runtime/runtime-outage';
import type { Route } from '../contract/step-contract';
import type { LaunchResult } from './result-exchange';

/** An agent's model host did not answer after the CLI's own retries. The launch is the whole of it, its follow-ups combined, with its cost. */
export class ModelHostUnavailable extends HostUnavailable {
  constructor(
    outage: ModelHostOutage,
    readonly result: LaunchResult,
  ) {
    super(outage.host, outage.detail, nextTryAt(Date.parse(result.finishedAt), HOST_RETRY_MS));
    this.name = 'ModelHostUnavailable';
  }
}

/** This file raises the error, so it tells a model host's outage from a code host's. */
export function isModelOutage(error: unknown): error is ModelHostUnavailable {
  return error instanceof ModelHostUnavailable;
}

/** How a visit whose model host did not answer is stored, with its own cost and tokens. */
export const HOST_VISIT = { status: 'interrupted', killReason: ERROR_CODES.HOST_UNAVAILABLE } as const;

/** The wait of a run whose host did not answer: it shows the reason and its next try. */
export function hostRoute(error: HostUnavailable): Route {
  return { to: 'wait', reason: error.message, code: ERROR_CODES.HOST_UNAVAILABLE, retryAt: error.retryAt };
}

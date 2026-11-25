import type { AgentRunResult } from '../../agent/agent-result';
import { ERROR_CODES } from '../../contract/error-codes';
import { HostUnavailable } from '../../core/swarmloop-error';
import { HOST_RETRY_MS } from '../../integrations/http';
import type { ModelHostOutage } from '../../integrations/agent-runtime/runtime-outage';
import type { Route } from '../contract/step-contract';

/** An agent's model host did not answer after the CLI's own retries. The launch is the whole of it, its follow-ups combined, with its cost. */
export class ModelHostUnavailable extends HostUnavailable {
  constructor(
    outage: ModelHostOutage,
    readonly result: AgentRunResult,
  ) {
    super(outage.host, outage.detail, new Date(Date.parse(result.finishedAt) + HOST_RETRY_MS).toISOString());
    this.name = 'ModelHostUnavailable';
  }
}

/** How a visit whose model host did not answer is stored, with its own cost and tokens. */
export const HOST_VISIT = { status: 'interrupted', killReason: ERROR_CODES.HOST_UNAVAILABLE } as const;

/** The wait of a run whose host did not answer: it shows the reason and its next try. */
export function hostRoute(error: HostUnavailable): Route {
  return { to: 'wait', reason: error.message, code: ERROR_CODES.HOST_UNAVAILABLE, retryAt: error.retryAt };
}

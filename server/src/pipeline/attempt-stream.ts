import { Injectable } from '@nestjs/common';
import { loadPriceTable } from '../agent/prices';
import type { PricedRequest } from '../agent/request-usage';
import { requestsOfStream } from '../agent/stream-requests';
import { AppConfig } from '../config/env';
import { agentFor } from '../config/agents';
import { REVIEW_STEPS } from '../contract/steps';
import { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import { root } from '../history/run-paths';
import type { AgentLaunchRequest } from '../steps/shared/agent-launch-request';
import type { CallSubject } from '../steps/shared/call-context';

/** The output files a step's attempt wrote: a code review writes one for each reviewer. */
function filesOf(step: string): readonly string[] {
  return step === 'code-review' ? REVIEW_STEPS : [step];
}

/** The requests one output file of an attempt holds, with what names their call and the agent that made them. */
interface StreamedRequests {
  subject: CallSubject;
  agent: Pick<AgentLaunchRequest, 'runtime' | 'model' | 'effort'>;
  requests: PricedRequest[];
}

/**
 * Reads what the output files of an attempt hold when its process died or a restart left its container running. The
 * agent kept making model requests that no server read. The settler hands them to the launcher, the one writer of the
 * log, before the visit is charged from the log's rows.
 */
@Injectable()
export class AttemptStream {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** `outputOf` gives what the output file of a step of the attempt holds. */
  async read(run: RunEntity, outputOf: (step: string) => string): Promise<StreamedRequests[]> {
    const found: StreamedRequests[] = [];
    if (run.activeAttempt === null) return found;
    for (const step of filesOf(run.currentStep)) {
      const raw = outputOf(step);
      const agent =
        raw.trim() === ''
          ? null
          : (agentFor(this.config.env, run, step) ?? agentFor(this.config.env, run, run.currentStep));
      if (!agent) continue;
      const prices = await loadPriceTable(root(this.config), agent.runtime, this.clock.now());
      found.push({ subject: { key: run.key, step, run }, agent, requests: requestsOfStream(raw, prices, agent.model) });
    }
    return found;
  }
}

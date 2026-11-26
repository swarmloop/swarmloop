import { ModelHostUnavailable } from './model-host-unavailable';
import type { LaunchResult } from './result-exchange';

/**
 * An agent's container was stopped from outside swarmloop (no kill of ours, no Stop of a person). It is a wait on the
 * outside like a model host that does not answer, so every place that takes that wait takes this one, with its next try.
 */
export class AgentStoppedFromOutside extends ModelHostUnavailable {
  constructor(signal: string, result: LaunchResult) {
    super({ host: 'agent container', detail: `stopped from outside by ${signal}` }, result);
    this.name = 'AgentStoppedFromOutside';
  }
}

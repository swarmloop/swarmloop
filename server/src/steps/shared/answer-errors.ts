import { SwarmloopError } from '../../core/swarmloop-error';

/** The answer of an agent was not accepted after the follow-ups. It holds every error of the last answer. */
export class ResultInvalid extends SwarmloopError {
  constructor(readonly errors: string[]) {
    super(`the agent's result was not accepted: ${errors.join('; ')}`, { category: 'model' });
    this.name = 'ResultInvalid';
  }
}

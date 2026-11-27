import { SwarmloopError } from '../../core/swarmloop-error';

/** The host's token endpoint refused the client id or secret of the application. */
export class AppRejectedError extends SwarmloopError {
  constructor(label: string, appLabel: string) {
    super(`${label} rejected the ${appLabel} ID or Secret`);
  }
}

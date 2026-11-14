import type { RunStop } from './run-stop';
import { STOP_NOTE } from '../contract/run-state';

/** Thrown where a step sees the Stop intent. The step ends blocked with the code STOPPED, not failed. */
export class StepStopped extends Error {
  /**
   * `external` is work outside this machine that may still run, such as a CI pipeline id and link. `message` says why
   * the run stopped when it was not the person's Stop.
   */
  constructor(external: string[] = [], message: string = STOP_NOTE) {
    super(external.length > 0 ? `${message}\nMay still run: ${external.join(', ')}` : message);
  }
}

/** Throws before a launch or an external effect when the run is asked to stop. */
export function assertNotStopped(runStop: RunStop, key: string, external: string[] = []): void {
  if (runStop.halted(key)) {
    throw new StepStopped(external);
  }
}

import type { RunStop } from '../../agent/run-stop';
import { STOP_NOTE } from '../../contract/run-state';

/** Thrown where a step sees the Stop intent. The step ends blocked with the code STOPPED, not failed. */
export class StepStopped extends Error {
  /** `external` is work outside this machine that may still run, such as a CI pipeline id and link. */
  constructor(external: string[] = []) {
    super(external.length > 0 ? `${STOP_NOTE}\nMay still run: ${external.join(', ')}` : STOP_NOTE);
  }
}

/** Throws before a launch or an external effect when the run is asked to stop. */
export function assertNotStopped(runStop: RunStop, key: string, external: string[] = []): void {
  if (runStop.halted(key)) {
    throw new StepStopped(external);
  }
}

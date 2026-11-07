import type { StepName } from '../../contract/steps';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { Route } from './step-contract';

/** The steps a step may send work back to. */
export const RETURNS: Partial<Record<StepName, readonly StepName[]>> = {
  'code-review': ['implement'],
  pipeline: ['implement'],
};

/** The steps a step may jump to, past the ones that follow it. */
export const JUMPS: Partial<Record<StepName, readonly StepName[]>> = {
  implement: ['commit', 'code-review'],
  pipeline: ['code-review'],
};

/** Throws when `step` ends with a return or a jump that the tables do not allow. */
export function assertRoute(step: StepName, route: Route): void {
  if (route.to !== 'return' && route.to !== 'jump') {
    return;
  }
  const allowed = (route.to === 'return' ? RETURNS : JUMPS)[step] ?? [];
  if (!allowed.includes(route.step)) {
    throw new SwarmloopError(`${step} may not ${route.to} to ${route.step}`);
  }
}

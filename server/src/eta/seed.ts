import { STEPS } from '../contract/steps';

/** The time a whole run takes while the server has no history. */
export const SEED_RUN_MS = 80 * 60_000;

/** The time from entering a step to the end, while the server has no history of it. */
export function seedFor(step: string): number {
  const index = (STEPS as readonly string[]).indexOf(step);
  if (index < 0) {
    return SEED_RUN_MS;
  }
  return (SEED_RUN_MS * (STEPS.length - index)) / STEPS.length;
}

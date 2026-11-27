import type { RunEntity } from '../../history/entities';
import type { StepName } from '../../contract/steps';

/** What the run view says of a block from a required check that failed again on unchanged files. */
export const CHECK_BLOCK_SENTENCE =
  'A required check failed again on unchanged files. Resume returns to implementation with the stored notes.';

/** The step the Resume of such a block starts: the run's implement step, wherever the block was written. */
export function checkBlockResumeStep(run: Pick<RunEntity, 'currentStep'>): StepName {
  return run.currentStep === 'implement-improve' ? 'implement-improve' : 'implement';
}

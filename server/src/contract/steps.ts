export const STEPS = [
  'requirements',
  'prepare',
  'research',
  'plan',
  'plan-improve',
  'branch',
  'implement',
  'implement-improve',
  'checks',
  'code-review',
  'commit',
  'merge-request',
  'pipeline',
  'done',
] as const;

export type StepName = (typeof STEPS)[number];

export const CODE_REVIEWERS = ['requirements', 'quality', 'regressions', 'security', 'performance'] as const;

export const REVIEW_STEPS: readonly string[] = CODE_REVIEWERS.map((name) => `code-review-${name}`);

export const PHASES = ['planning', 'implementation', 'checks', 'code-review', 'ci'] as const;

export type PhaseName = (typeof PHASES)[number];

export const PHASE_STEPS: Record<PhaseName, readonly string[]> = {
  planning: ['requirements', 'prepare', 'research', 'plan', 'plan-improve'],
  implementation: ['branch', 'implement', 'implement-improve'],
  checks: ['checks'],
  'code-review': ['code-review'],
  ci: ['commit', 'merge-request', 'pipeline', 'done'],
};

/** Why the merge visit of a split parent skips implement-improve. */
export const IMPROVE_SKIPPED_NOTE = 'each task checked its own work';

export function isReviewStep(value: string): boolean {
  return REVIEW_STEPS.includes(value);
}

export function pipelineStepOf(value: string): string {
  return isReviewStep(value) ? 'code-review' : value;
}

export function reviewerOf(value: string): string | undefined {
  return isReviewStep(value) ? value.slice('code-review-'.length) : undefined;
}

/** The reviewer of a step the caller already knows is a review step. Throws for any other name. */
export function requireReviewer(step: string): string {
  const reviewer = reviewerOf(step);
  if (reviewer === undefined) {
    throw new Error(`${step} is not a code review step`);
  }
  return reviewer;
}

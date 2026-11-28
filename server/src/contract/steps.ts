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

export const CODE_REVIEWERS = ['requirements', 'code', 'behavior'] as const;

export const REVIEW_STEPS: readonly string[] = CODE_REVIEWERS.map((name) => `code-review-${name}`);

/** The reviewers of runs reviewed before the three reviewers. Read only: a new round never starts one. */
export const RETIRED_REVIEWERS = ['quality', 'regressions', 'security', 'performance'] as const;

/** Every reviewer a run can have stored reviews of: the current ones, then the retired ones. */
export const STORED_REVIEWERS = [...CODE_REVIEWERS, ...RETIRED_REVIEWERS] as const;

export type StoredReviewer = (typeof STORED_REVIEWERS)[number];

export const STORED_REVIEW_STEPS: readonly string[] = STORED_REVIEWERS.map((name) => `code-review-${name}`);

/**
 * The reviewers a run was reviewed by, from the reviewer names it has stored, oldest first. The last name that is not
 * requirements decides: a retired reviewer gives the retired set, anything else the current three.
 */
export function reviewerSetOf(names: readonly string[]): readonly StoredReviewer[] {
  const decisive = names.filter((name) => name !== 'requirements' && STORED_REVIEWERS.some((r) => r === name)).at(-1);
  return RETIRED_REVIEWERS.some((name) => name === decisive) ? ['requirements', ...RETIRED_REVIEWERS] : CODE_REVIEWERS;
}

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
  return STORED_REVIEW_STEPS.includes(value);
}

export function pipelineStepOf(value: string): string {
  return isReviewStep(value) ? 'code-review' : value;
}

function reviewerOf(value: string): string | undefined {
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

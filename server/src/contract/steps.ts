export const STEPS = [
  'requirements',
  'prepare',
  'research',
  'plan',
  'plan-improve',
  'branch',
  'implement',
  'implement-improve',
  'verify',
  'code-review',
  'commit',
  'merge-request',
  'pipeline',
  'done',
] as const;

export type StepName = (typeof STEPS)[number];

export const CODE_REVIEWERS = ['requirements', 'quality', 'regressions', 'security', 'performance'] as const;

export const REVIEW_STEPS: readonly string[] = CODE_REVIEWERS.map((name) => `code-review-${name}`);

export const PHASES = ['requirements', 'brainstorm', 'implementation', 'code-review', 'ci'] as const;

export type PhaseName = (typeof PHASES)[number];

export const PHASE_STEPS: Record<PhaseName, readonly string[]> = {
  requirements: ['requirements'],
  brainstorm: ['prepare', 'research', 'plan', 'plan-improve'],
  implementation: ['branch', 'implement', 'implement-improve', 'verify'],
  'code-review': ['code-review'],
  ci: ['commit', 'merge-request', 'pipeline', 'done'],
};

export function isReviewStep(value: string): boolean {
  return REVIEW_STEPS.includes(value);
}

export function pipelineStepOf(value: string): string {
  return isReviewStep(value) ? 'code-review' : value;
}

export function reviewerOf(value: string): string | undefined {
  return isReviewStep(value) ? value.slice('code-review-'.length) : undefined;
}

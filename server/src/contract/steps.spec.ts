import {
  isReviewStep,
  PHASES,
  PHASE_STEPS,
  pipelineStepOf,
  requireReviewer,
  REVIEW_STEPS,
  reviewerSetOf,
  STEPS,
} from './steps';

describe('pipelineStepOf', () => {
  it('maps every reviewer step to the code-review phase step', () => {
    for (const step of REVIEW_STEPS) {
      expect(pipelineStepOf(step)).toBe('code-review');
    }
  });

  it('keeps a non-review step as it is', () => {
    expect(pipelineStepOf('implement')).toBe('implement');
  });
});

describe('REVIEW_STEPS', () => {
  it('lists one step per reviewer', () => {
    expect(REVIEW_STEPS).toEqual(['code-review-requirements', 'code-review-code', 'code-review-behavior']);
  });
});

describe('a run reviewed by the retired reviewers', () => {
  it('still knows their steps as review steps of the code-review phase', () => {
    expect(isReviewStep('code-review-code')).toBe(true);
    expect(isReviewStep('code-review-security')).toBe(true);
    expect(isReviewStep('code-review-other')).toBe(false);
    expect(pipelineStepOf('code-review-security')).toBe('code-review');
    expect(requireReviewer('code-review-security')).toBe('security');
  });
});

describe('reviewerSetOf', () => {
  const retired = ['requirements', 'quality', 'regressions', 'security', 'performance'];

  it('gives the three reviewers when nothing is stored yet', () => {
    expect(reviewerSetOf([])).toEqual(['requirements', 'code', 'behavior']);
    expect(reviewerSetOf(['requirements'])).toEqual(['requirements', 'code', 'behavior']);
  });

  it('gives the retired five for a run whose last reviewer other than requirements is retired', () => {
    expect(reviewerSetOf(['requirements', 'security'])).toEqual(retired);
  });

  it('gives the three reviewers once a current one reviewed after a retired one', () => {
    expect(reviewerSetOf(['quality', 'code'])).toEqual(['requirements', 'code', 'behavior']);
  });
});

describe('PHASE_STEPS', () => {
  it('places every non-review step in a phase', () => {
    const placed = Object.values(PHASE_STEPS).flat();
    for (const step of STEPS) {
      expect(placed).toContain(step);
    }
  });
});

describe('PHASES', () => {
  it('are exactly planning, implementation, checks, code-review and ci, with checks as its own step', () => {
    const names = ['planning', 'implementation', 'checks', 'code-review', 'ci'];
    expect([...PHASES]).toEqual(names);
    expect(Object.keys(PHASE_STEPS)).toEqual(names);
    expect(PHASE_STEPS.checks).toEqual(['checks']);
  });
});

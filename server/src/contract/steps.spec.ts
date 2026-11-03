import { PHASE_STEPS, pipelineStepOf, REVIEW_STEPS, STEPS } from './steps';

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
    expect(REVIEW_STEPS).toEqual([
      'code-review-requirements',
      'code-review-quality',
      'code-review-regressions',
      'code-review-security',
      'code-review-performance',
    ]);
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

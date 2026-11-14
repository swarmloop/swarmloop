import { defineResult, isResultKind } from './result-definition';
import { implementation, implementationAfterReview } from './definitions/implementation';
import { implementationImprove, implementationImproveAfterReview } from './definitions/implementation-improve';
import { readResult } from './read-result';
import { resultPrompt } from './result-prompt';
import { block, sample } from './result.spec-helpers';

describe('result definition', () => {
  it('names the kind of the stored object after the definition', () => {
    expect(sample.kind).toBe('sample_result');
    expect(defineResult('review_quality', sample.schema).kind).toBe('review_quality_result');
  });

  it('tells a result kind from a rendered one', () => {
    expect(isResultKind('plan_result')).toBe(true);
    expect(isResultKind('plan')).toBe(false);
  });

  it.each([
    [implementation, implementationAfterReview, { implementation: ['a'], summary: ['b'] }],
    [implementationImprove, implementationImproveAfterReview, { summary: ['b'] }],
  ])('asks for the rejected findings only in the after-review definition of %#', (base, after, given) => {
    const rejected = [{ reviewer: 'quality', finding: 'Use theme.alpha', reason: 'No alpha here.' }];
    expect(after.name).toBe(base.name);
    expect(after.kind).toBe(base.kind);
    expect(resultPrompt(base)).not.toContain('rejected');
    expect(resultPrompt(after)).toContain('- rejected[].reviewer (string, required)');
    expect(readResult(after, block({ ...given, rejected })).ok).toBe(true);
    expect(readResult(after, block(given)).ok).toBe(true);
    expect(readResult(base, block({ ...given, rejected })).ok).toBe(false);
    expect(readResult(after, block({ ...given, rejected: [{ reviewer: 'quality', finding: 'x' }] })).ok).toBe(false);
  });
});

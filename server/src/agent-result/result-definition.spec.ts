import { defineResult, isResultKind } from './result-definition';
import { sample } from './result.spec-helpers';

describe('result definition', () => {
  it('names the kind of the stored object after the definition', () => {
    expect(sample.kind).toBe('sample_result');
    expect(defineResult('review_quality', sample.schema).kind).toBe('review_quality_result');
  });

  it('tells a result kind from a rendered one', () => {
    expect(isResultKind('plan_result')).toBe(true);
    expect(isResultKind('plan')).toBe(false);
  });
});

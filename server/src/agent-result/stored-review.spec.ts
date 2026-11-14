import { storedReview } from './stored-review';

const result = (decision: string) => JSON.stringify({ decision, review: 'from result', summary: [] });

describe('storedReview', () => {
  it('reads the stored result before the rendered document', () => {
    const documents = [
      { kind: 'review_quality', body: 'text\ndecision: ok\n' },
      { kind: 'review_quality_result', body: result('return') },
    ];
    expect(storedReview('quality', documents)).toEqual({ decision: 'return', review: 'from result', summary: [] });
  });

  it('takes the latest result of the reviewer and no other reviewer', () => {
    const documents = [
      { kind: 'review_quality_result', body: result('return') },
      { kind: 'review_security_result', body: result('ok') },
      { kind: 'review_quality_result', body: result('ok') },
    ];
    expect(storedReview('quality', documents)?.decision).toBe('ok');
    expect(storedReview('requirements', documents)).toBeNull();
  });

  it('refuses a stored result that the review definition does not accept', () => {
    const documents = [{ kind: 'review_quality_result', body: JSON.stringify({ decision: 'approve', summary: [] }) }];
    expect(() => storedReview('quality', documents)).toThrow('review_quality_result is not valid');
  });

  it('falls back to the rendered document of a run from before results', () => {
    const documents = [{ kind: 'review_quality', body: 'old\n\nsummary:\n- a thing\n\ndecision: return\n' }];
    expect(storedReview('quality', documents)).toEqual({
      decision: 'return',
      review: 'old\n\nsummary:\n- a thing',
      summary: ['a thing'],
    });
  });
});

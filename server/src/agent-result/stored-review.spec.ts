import { storedReview, storedReviewers } from './stored-review';

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

describe('storedReviewers', () => {
  it('gives the three reviewers for a run with no review yet or with only the requirements review', () => {
    expect(storedReviewers([])).toEqual(['requirements', 'code', 'behavior']);
    expect(storedReviewers([{ id: 1, kind: 'review_requirements_result' }])).toEqual([
      'requirements',
      'code',
      'behavior',
    ]);
  });

  it('gives the retired five for a run reviewed by the old reviewers', () => {
    const documents = [
      { id: 1, kind: 'review_requirements' },
      { id: 2, kind: 'review_quality_result' },
      { id: 3, kind: 'review_security' },
    ];
    expect(storedReviewers(documents)).toEqual(['requirements', 'quality', 'regressions', 'security', 'performance']);
  });

  it('gives the three reviewers for a run whose newest review is by a current reviewer', () => {
    const documents = [
      { id: 2, kind: 'review_code_result' },
      { id: 1, kind: 'review_quality_result' },
    ];
    expect(storedReviewers(documents)).toEqual(['requirements', 'code', 'behavior']);
  });

  it('decides by id, not by the order the documents are listed in', () => {
    const documents = [
      { id: 9, kind: 'review_security_result' },
      { id: 4, kind: 'review_code_result' },
    ];
    expect(storedReviewers(documents)).toEqual(['requirements', 'quality', 'regressions', 'security', 'performance']);
  });

  it('counts the reviewers of an open round as newer than every stored review', () => {
    const documents = [{ id: 1, kind: 'review_security_result' }];
    expect(storedReviewers(documents, ['requirements', 'code', 'behavior'])).toEqual([
      'requirements',
      'code',
      'behavior',
    ]);
    expect(storedReviewers(documents, ['requirements'])).toEqual([
      'requirements',
      'quality',
      'regressions',
      'security',
      'performance',
    ]);
  });
});

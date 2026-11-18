import { othersOpenLine } from './code-review-round-result';

describe('othersOpenLine', () => {
  it('names the reviewers with no answer and why the report waits', () => {
    expect(othersOpenLine({ missing: ['quality', 'regressions', 'security', 'performance'], returned: [] })).toBe(
      'code-review waiting: quality, regressions, security and performance have no answer for these files; the report waits for them',
    );
  });

  it('names the reviewers that returned', () => {
    expect(othersOpenLine({ missing: [], returned: ['regressions'] })).toBe(
      'code-review waiting: regressions returned; the report waits for them',
    );
  });

  it('names both, and agrees the verb with one name', () => {
    expect(othersOpenLine({ missing: ['security'], returned: ['quality', 'regressions'] })).toBe(
      'code-review waiting: security has no answer for these files, quality and regressions returned; the report waits for them',
    );
  });
});

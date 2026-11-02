import { reviewBrief } from './review-report';

describe('review brief', () => {
  it('gives the report the decision and the full text of each check', () => {
    const text = reviewBrief([
      { kind: 'review_quality', decision: 'return', body: 'summary:\n- The parser drops an empty segment\n\ndecision: return\n' },
      { kind: 'review_security', decision: 'ok', body: 'summary:\n- The query stays parameterized\n\ndecision: ok\n' },
    ]);
    expect(text).toContain('## Quality\ndecision: return\n\nsummary:');
    expect(text).toContain('The parser drops an empty segment');
    expect(text).toContain('## Security\ndecision: ok');
    expect(text.indexOf('## Quality')).toBeLessThan(text.indexOf('## Security'));
  });
});

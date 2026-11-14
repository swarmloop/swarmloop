import { legacyRequirementsReview, legacyReview } from './review';

describe('legacy review', () => {
  it('reads the decision, the text and the summary list of a rendered review', () => {
    const body =
      'Looked at the parser.\n\nsummary:\n- the parser drops a segment\n- the test misses it\n\ndecision: return\n';
    expect(legacyReview(body)).toEqual({
      decision: 'return',
      review: 'Looked at the parser.\n\nsummary:\n- the parser drops a segment\n- the test misses it',
      summary: ['the parser drops a segment', 'the test misses it'],
    });
  });

  it('keeps the last decision and reads a decorated line and a reason after it', () => {
    expect(legacyReview('a\ndecision: ok\nlater\n**decision: return — one broken behavior**\n')?.decision).toBe(
      'return',
    );
    expect(legacyReview('notes\n`decision: ok`\n')?.decision).toBe('ok');
  });

  it('reads the location of each met line of an old requirements review', () => {
    const body = 'summary:\n- met: 1. Ship the field (src/readme.ts)\n- partial: 2. Tests - none\n\ndecision: ok\n';
    expect(legacyRequirementsReview(body)?.met).toEqual(['src/readme.ts']);
    expect(
      legacyRequirementsReview('summary:\n- met: 1. Ship the field in src/readme.ts\n\ndecision: ok\n'),
    ).not.toHaveProperty('met');
  });

  it('is null when no decision is named', () => {
    expect(legacyReview('notes\ndecision: okay then\n')).toBeNull();
    expect(legacyReview('')).toBeNull();
  });
});

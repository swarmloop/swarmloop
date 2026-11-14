import type { StepContext } from '../base-step';
import { opinionOf, reviewDocuments } from './code-review-record';
import { closeReview, reviewBrief } from './review-report';

describe('review brief', () => {
  it('gives the report the decision and the full text of each check', () => {
    const text = reviewBrief([
      {
        kind: 'review_quality',
        decision: 'return',
        body: 'summary:\n- The parser drops an empty segment\n\ndecision: return\n',
      },
      { kind: 'review_security', decision: 'ok', body: 'summary:\n- The query stays parameterized\n\ndecision: ok\n' },
    ]);
    expect(text).toContain('## Quality\ndecision: return\n\nsummary:');
    expect(text).toContain('The parser drops an empty segment');
    expect(text).toContain('## Security\ndecision: ok');
    expect(text.indexOf('## Quality')).toBeLessThan(text.indexOf('## Security'));
  });
});

describe('decision facts of a report visit', () => {
  const ctx = {
    opened: { startedAt: 'start', started: 0 },
    clock: { iso: () => 'end', now: () => 5 },
    end: async (result: unknown) => result,
  } as unknown as StepContext;

  it('lists the decision of each review from its stored result, and of an older run from its document', async () => {
    const result = (decision: 'ok' | 'return') => ({ decision, review: 'notes', summary: [] });
    const documents = [
      // The text says ok; the stored result says return.
      { kind: 'review_quality', fileName: '', body: 'notes\ndecision: ok\n' },
      { kind: 'review_quality_result', fileName: '', body: JSON.stringify(result('return')) },
      ...reviewDocuments(opinionOf('review_security', result('ok'))),
      { kind: 'review_performance', fileName: '', body: 'old run\ndecision: return\n' },
    ];
    const closed = (await closeReview(ctx, { to: 'next' }, 'line', documents, [])) as unknown as {
      facts: { details: string[] };
    };
    expect(closed.facts.details).toEqual(['quality: return', 'security: ok', 'performance: return']);
  });
});

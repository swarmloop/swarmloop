import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import { opinionOf, renderReview, reportDocuments, reviewDocuments, summaryNote } from './code-review-record';
import { CODE_REVIEWERS } from '../../contract/steps';
import { storedReview } from '../../agent-result/stored-review';

const RETURN = {
  decision: 'return' as const,
  review: 'summary:\n- The parser drops an empty segment',
  summary: ['The parser drops an empty segment'],
};

describe('review documents', () => {
  it.each(CODE_REVIEWERS)('round-trips an old %s review containing a met line through its result codec', (name) => {
    const entry = 'met: the parser keeps the segment (src/parser.ts)';
    const kind = `review_${name}`;
    const legacy = storedReview(name, [{ kind, body: `summary:\n- ${entry}\n\ndecision: ok\n` }]);
    if (!legacy) {
      throw new Error('the legacy review is missing');
    }
    const restored = storedReview(name, reviewDocuments(opinionOf(kind, legacy)));
    expect(restored).toEqual(legacy);
    expect(restored?.summary).toEqual([entry]);
    expect(restored?.met).toEqual(name === 'requirements' ? ['src/parser.ts'] : undefined);
  });

  it('renders the review followed by the decision line', () => {
    expect(renderReview(RETURN)).toBe('summary:\n- The parser drops an empty segment\ndecision: return\n');
  });

  it('writes one line for each requirement mark in id order before the decision line', () => {
    const requirements = [
      { id: 'R10', status: 'met' as const, note: 'in a.ts' },
      { id: 'R2', status: 'missing' as const, note: 'no case' },
    ];
    expect(renderReview({ ...RETURN, requirements })).toBe(
      'summary:\n- The parser drops an empty segment\nR2 missing: no case\nR10 met: in a.ts\ndecision: return\n',
    );
  });

  it('keeps the marks through the stored result', () => {
    const requirements = [{ id: 'R1', status: 'partial' as const, note: 'half' }];
    const documents = reviewDocuments(opinionOf('review_requirements', { ...RETURN, requirements }));
    expect(storedReview('requirements', documents)?.requirements).toEqual(requirements);
  });

  it('stores the rendered review next to the result it was rendered from', () => {
    const documents = reviewDocuments(opinionOf('review_quality', RETURN));
    expect(documents.map((document) => document.kind)).toEqual(['review_quality', 'review_quality_result']);
    expect(documents[0].body).toBe('summary:\n- The parser drops an empty segment\ndecision: return\n');
    expect(JSON.parse(documents[1].body)).toEqual(RETURN);
  });

  it('renders the reviewer reason after the decision line, and nothing without one', () => {
    const answered = renderReview({ ...RETURN, decision: 'ok', reason: 'The answer holds.' });
    expect(answered).toBe('summary:\n- The parser drops an empty segment\ndecision: ok\nreason: The answer holds.\n');
    expect(renderReview(RETURN)).toBe('summary:\n- The parser drops an empty segment\ndecision: return\n');
  });

  it('gives the handoff the summary list, or the decision when there is none', () => {
    expect(summaryNote(RETURN)).toBe('- The parser drops an empty segment\n');
    expect(summaryNote({ ...RETURN, summary: [] })).toBe('- return\n');
  });
});

describe('report documents', () => {
  it('stores the report text it is given and the parts it was rendered from', () => {
    const parts: ReviewReportResult = {
      line: 'Parser fixed.',
      done: ['one thing'],
      worthALook: [],
      notes: { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' },
      risk: 'low',
      riskReason: 'small',
    };
    const documents = reportDocuments('the report\n', parts);
    expect(documents.map((document) => document.kind)).toEqual(['review_report', 'review_report_result']);
    expect(documents[0].body).toBe('the report\n');
    expect(JSON.parse(documents[1].body)).toEqual(parts);
  });
});

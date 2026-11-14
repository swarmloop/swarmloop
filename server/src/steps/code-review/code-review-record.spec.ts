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
  it('renders the parts the report gave as sections and stores its result', () => {
    const documents = reportDocuments({
      whatChanged: 'Parser fixed.',
      codeReview: 'All ok.',
      whatToFix: '- one thing',
    });
    expect(documents.map((document) => document.kind)).toEqual(['review_report', 'review_report_result']);
    expect(documents[0].body).toBe(
      '## What changed\n\nParser fixed.\n\n## Code review\n\nAll ok.\n\n## What to fix\n\n- one thing\n',
    );
    expect(JSON.parse(documents[1].body)).toEqual({
      whatChanged: 'Parser fixed.',
      codeReview: 'All ok.',
      whatToFix: '- one thing',
    });
  });
});

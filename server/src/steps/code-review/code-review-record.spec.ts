import {
  opinionOf,
  decidedOk,
  renderReview,
  reportDocuments,
  reviewDocuments,
  summaryNote,
} from './code-review-record';

const RETURN = {
  decision: 'return' as const,
  review: 'summary:\n- The parser drops an empty segment',
  summary: ['The parser drops an empty segment'],
};

describe('review documents', () => {
  it('renders the review followed by the decision line', () => {
    expect(renderReview(RETURN)).toBe('summary:\n- The parser drops an empty segment\ndecision: return\n');
  });

  it('stores the rendered review next to the result it was rendered from', () => {
    const documents = reviewDocuments(opinionOf('review_quality', RETURN));
    expect(documents.map((document) => document.kind)).toEqual(['review_quality', 'review_quality_result']);
    expect(documents[0].body).toBe('summary:\n- The parser drops an empty segment\ndecision: return\n');
    expect(JSON.parse(documents[1].body)).toEqual(RETURN);
  });

  it('accepts a repeated return as ok with the same review text', () => {
    const accepted = decidedOk(opinionOf('review_quality', RETURN));
    expect(accepted.decision).toBe('ok');
    expect(accepted.body).toBe('summary:\n- The parser drops an empty segment\ndecision: ok\n');
    expect(accepted.result.decision).toBe('ok');
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

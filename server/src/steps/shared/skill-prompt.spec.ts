import { parseSummary, summaryOr } from './skill-prompt';

const old = ['implementation:', '- changed A', '', 'summary:', '- why', ''].join('\n');
const withCause = ['cause:', '- the parser dropped the suffix', '', old].join('\n');
const causeAfter = `${old}\ncause:\n- late cause\n`;

describe('parseSummary', () => {
  it('reads the summary of an old answer', () => {
    expect(parseSummary(old)).toBe('- why\n');
  });

  it('keeps a cause section out of the summary', () => {
    expect(parseSummary(withCause)).toBe('- why\n');
    expect(parseSummary(causeAfter)).toBe('- why\n');
  });
});

describe('summaryOr', () => {
  it('reads the summary and falls back when it is missing', () => {
    expect(summaryOr(withCause, 'fallback')).toBe('- why\n');
    expect(summaryOr('cause:\n- only a cause\n', 'fallback')).toBe('fallback\n');
  });
});

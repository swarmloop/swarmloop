import { parseResearch } from './research-record';

describe('parseResearch', () => {
  it('keeps the open questions and ignores any repo list', () => {
    const parsed = parseResearch(
      ['notes', 'repos:', '- catalog-api', 'questions:', '- which field is optional?'].join('\n'),
    );
    expect(parsed.questions).toBe('- which field is optional?\n');
  });

  it('treats an empty questions section as no open items', () => {
    const parsed = parseResearch(['summary:', '- done', 'questions:', '- none'].join('\n'));
    expect(parsed.questions).toBe('');
  });

  it('reads a heading wrapped in backticks', () => {
    const parsed = parseResearch(['summary:', '- done', '`questions:`', '- none'].join('\n'));
    expect(parsed.questions).toBe('');
  });

  it('rejects a response that has no questions section', () => {
    expect(() => parseResearch('summary:\n- done\n')).toThrow('questions is missing');
  });
});

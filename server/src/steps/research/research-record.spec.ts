import { parseImpact, parseResearch, renderImpact } from './research-record';

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

describe('parseImpact', () => {
  it('gives an empty list without the section', () => {
    expect(parseImpact('summary:\n- done\nquestions:\n- none\n')).toEqual({ items: [], notes: [] });
  });

  it('reads each status, with a named removal', () => {
    const text = [
      'impact:',
      '- live agent log | step-documents.tsx | unreachable',
      '- run list filter | runs.tsx | removed (named)',
      '- stop button | stop.tsx | kept',
      '- title | head.tsx | changed',
      '- old flag | flags.ts | removed',
      '',
      'summary:',
      '- done',
    ].join('\n');
    const parsed = parseImpact(text);
    expect(parsed.items.map((item) => item.status)).toEqual([
      'unreachable',
      'removed (named)',
      'kept',
      'changed',
      'removed',
    ]);
    expect(parsed.items[0]).toEqual({
      capability: 'live agent log',
      file: 'step-documents.tsx',
      status: 'unreachable',
    });
    expect(parsed.notes).toEqual([]);
    expect(renderImpact(parsed.items)).toContain('- live agent log | step-documents.tsx | unreachable\n');
  });

  it('treats a none line as an empty list without a note', () => {
    expect(parseImpact('impact:\n- none\n')).toEqual({ items: [], notes: [] });
  });

  it('ignores malformed lines with a note', () => {
    const parsed = parseImpact(
      ['impact:', '- no bars here', '- a | b | maybe', '- a | b | kept | extra', '- ok | f.ts | kept', '- none'].join(
        '\n',
      ),
    );
    expect(parsed.items).toEqual([{ capability: 'ok', file: 'f.ts', status: 'kept' }]);
    expect(parsed.notes).toHaveLength(3);
    expect(parsed.notes[0]).toBe('ignored impact line: no bars here');
  });
});

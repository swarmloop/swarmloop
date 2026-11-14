import { renderImpact, renderQuestions } from './research-record';

describe('renderImpact', () => {
  it('writes one bar-separated bullet per capability', () => {
    expect(renderImpact([{ capability: 'live agent log', file: 'step-documents.tsx', status: 'unreachable' }])).toBe(
      '- live agent log | step-documents.tsx | unreachable\n',
    );
  });

  it('writes nothing for an empty list', () => {
    expect(renderImpact([])).toBe('');
  });
});

describe('renderQuestions', () => {
  it('writes one bullet per question', () => {
    expect(renderQuestions(['a?', 'b?'])).toBe('- a?\n- b?\n');
  });

  it('writes nothing when there is no question', () => {
    expect(renderQuestions([])).toBe('');
  });
});

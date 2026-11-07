import { parseImplementation, reviewedImplementation } from './implement-record';

const old = ['implementation:', '- changed A', '- changed B', '', 'summary:', '- why', ''].join('\n');
const withCause = ['cause:', '- the parser dropped the suffix', '', old].join('\n');

describe('parseImplementation', () => {
  it('reads an implement answer without a cause section', () => {
    expect(parseImplementation(old)).toBe('- changed A\n- changed B\n');
  });

  it('reads an implement answer with a cause section', () => {
    expect(parseImplementation(withCause)).toBe('- changed A\n- changed B\n');
  });
});

describe('reviewedImplementation', () => {
  it('returns the notes of an old answer and of one with a cause', () => {
    expect(reviewedImplementation(old)).toBe('- changed A\n- changed B\n');
    expect(reviewedImplementation(withCause)).toBe('- changed A\n- changed B\n');
  });

  it('returns nothing when the first pass stands', () => {
    expect(reviewedImplementation('cause:\n- none\n\nimplementation:\n- The first pass stands.\n')).toBe('');
  });
});

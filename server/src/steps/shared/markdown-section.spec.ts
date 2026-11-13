import { bulletSection, section } from './markdown-section';

describe('Markdown sections', () => {
  it('parses the recorded hash-heading implementation answer', () => {
    const text = ['## implementation:', '- fixed the parser', '', '## summary:', '- accepts Markdown headings'].join(
      '\n',
    );

    expect(bulletSection(text, 'implementation')).toBe('- fixed the parser\n');
    expect(bulletSection(text, 'summary')).toBe('- accepts Markdown headings\n');
  });

  it.each(['**implementation:**', '### Implementation:'])('normalizes %s', (title) => {
    expect(bulletSection(`${title}\n- changed`, 'implementation')).toBe('- changed\n');
  });

  it('does not treat a prose mention as a section', () => {
    const text = ['## implementation:', '- changed', 'The implementation: is described below.'].join('\n');

    expect(bulletSection(text, 'implementation')).toBe('- changed\n');
  });

  it('ends a section at the needs label', () => {
    const text = ['summary:', '- chose x', 'needs:', '- a: the policy'].join('\n');

    expect(bulletSection(text, 'summary')).toBe('- chose x\n');
  });

  it('keeps legacy cause and files/proof section bodies', () => {
    const text = ['cause:', '- parser', '', 'files:', '- a.ts', '', 'proof:', '- npm test'].join('\n');

    expect(bulletSection(text, 'cause')).toBe('- parser\n');
    expect(bulletSection(text, 'files')).toBe('- a.ts\n');
    expect(bulletSection(text, 'proof')).toBe('- npm test\n');
  });

  it.each(['contract', 'plan', 'implementation'])('reads %s whole when a body line ends with a colon', (name) => {
    const text = [
      `${name}:`,
      '- first',
      '  indented line that ends with:',
      'A sentence that ends with:',
      '- last',
      '',
      'summary:',
      '- why',
    ].join('\n');

    expect(section(text, name)).toBe(
      ['- first', '  indented line that ends with:', 'A sentence that ends with:', '- last', ''].join('\n'),
    );
  });

  it('does not start or end a section at an indented label', () => {
    const text = ['tasks:', '- a', '  summary:', '  more', '', 'summary:', '- why'].join('\n');

    expect(section(text, 'tasks')).toBe(['- a', '  summary:', '  more', ''].join('\n'));
    expect(section(['plan:', '- x', '  summary:'].join('\n'), 'summary')).toBeNull();
  });
});

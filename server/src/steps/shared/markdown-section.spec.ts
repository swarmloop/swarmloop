import { bulletSection } from './markdown-section';

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

  it('keeps legacy cause and files/proof section bodies', () => {
    const text = ['cause:', '- parser', '', 'files:', '- a.ts', '', 'proof:', '- npm test'].join('\n');

    expect(bulletSection(text, 'cause')).toBe('- parser\n');
    expect(bulletSection(text, 'files')).toBe('- a.ts\n');
    expect(bulletSection(text, 'proof')).toBe('- npm test\n');
  });
});

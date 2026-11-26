import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownBody } from './markdown-body';

describe('MarkdownBody', () => {
  it('renders Markdown as text', () => {
    render(<MarkdownBody text={'## Summary\n\nThe **fix** works.'} />);

    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('fix')).toBeInTheDocument();
  });

  it('pretty-prints a JSON body', () => {
    render(<MarkdownBody text={'{"a":1,"b":[2]}'} />);

    expect(screen.getByText(/"a": 1/).textContent).toBe(JSON.stringify({ a: 1, b: [2] }, null, 2));
  });

  const report = [
    '<!-- swarmloop:report -->',
    '## ✅ Ready to merge · risk: low',
    '',
    '| Requirements | Checks | CI | Review | Returns | Time |',
    '|---|---|---|---|---|---|',
    '| 9/9 met | 12/12 | 🟢 | 5/5 ok | 2, both fixed | 38 min |',
    '',
    '<details><summary>Reviewer notes (5)</summary>',
    '',
    '- **Requirements ✅** Both fixed.',
    '- **Quality ✅** Nothing new.',
    '</details>',
    '',
    'After the notes.',
    '<!-- /swarmloop:report -->',
  ].join('\n');

  it('renders GFM tables, strikethrough and autolinks', () => {
    render(<MarkdownBody text={`${report}\n\n~~old~~ https://example.com/a`} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(6);
    expect(screen.getByText('old').tagName).toBe('DEL');
    expect(screen.getByRole('link', { name: 'https://example.com/a' })).toBeInTheDocument();
  });

  it('left-aligns table cells under their headers', () => {
    render(<MarkdownBody text={report} />);

    expect(screen.getByRole('table')).toHaveStyle({ borderCollapse: 'collapse' });
    expect(screen.getAllByRole('columnheader')[0]).toHaveStyle({ textAlign: 'left' });
    expect(screen.getAllByRole('cell')[0]).toHaveStyle({ textAlign: 'left' });
  });

  it('folds reviewer notes into a closed details block with markdown inside', () => {
    const { container } = render(<MarkdownBody text={report} />);

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Reviewer notes (5)');
    expect(details?.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('After the notes.')).toBeInTheDocument();
  });

  it('shows no marker text', () => {
    const { container } = render(<MarkdownBody text={report} />);

    expect(container.textContent).not.toContain('swarmloop:report');
  });

  it('does not render raw HTML from the text', () => {
    const { container } = render(<MarkdownBody text={'Hi <b>x</b> and <script>alert(1)</script>'} />);

    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('<b>');
    expect(container.textContent).not.toContain('<script>');
  });
});

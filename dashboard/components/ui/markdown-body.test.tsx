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
});

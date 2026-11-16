import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentBody } from './document-detail';

const coverage = JSON.stringify([
  { id: 'R1', text: 'the form saves', items: ['save the form', 'T2 wire the button'] },
  { id: 'R2', text: 'the list sorts', items: [] },
]);

describe('requirement documents', () => {
  it('shows each requirement with the items that cover it', () => {
    const { container } = render(<DocumentBody kind="requirement_coverage" body={coverage} />);
    expect(screen.getByText('R1 the form saves')).toBeTruthy();
    expect(container.textContent).toContain('save the form; T2 wire the button');
    expect(container.textContent).not.toContain('{');
    expect(container.textContent).not.toContain('"items"');
  });

  it('shows a requirement with no items as not covered', () => {
    render(<DocumentBody kind="requirement_coverage" body={coverage} />);
    expect(screen.getByText('R2 the list sorts').parentElement?.textContent).toContain('not covered');
  });

  it('shows the numbered requirements of a list', () => {
    const body = JSON.stringify([
      { id: 'R1', text: 'the form saves' },
      { id: 'R2', text: 'the list sorts' },
    ]);
    const { container } = render(<DocumentBody kind="requirement_list" body={body} />);
    expect(screen.getByText('R1 the form saves')).toBeTruthy();
    expect(screen.getByText('R2 the list sorts')).toBeTruthy();
    expect(container.textContent).not.toContain('not covered');
    expect(container.textContent).not.toContain('"id"');
  });

  it('shows a body that is not JSON as plain text', () => {
    render(<DocumentBody kind="requirement_list" body="R1 the form saves" />);
    expect(screen.getByText('R1 the form saves')).toBeTruthy();
  });
});

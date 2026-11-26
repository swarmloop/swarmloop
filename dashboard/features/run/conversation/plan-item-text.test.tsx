import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PlanItemText } from './plan-item-text';

const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);

describe('PlanItemText', () => {
  it('shows five of 30 paths one per line in the code font, and the rest on `and 25 more files`', async () => {
    const user = userEvent.setup({ delay: null });
    render(<PlanItemText item={`Add logging - files: ${paths(30).join(', ')} - proof: a.spec.ts`} />);

    expect(screen.getByText('Add logging')).toBeVisible();
    expect(screen.getByText('src/file-4.ts')).toHaveStyle({ fontFamily: 'var(--font-mono)' });
    expect(screen.queryByText('src/file-5.ts')).toBeNull();
    expect(screen.getByText('proof: a.spec.ts')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'and 25 more files' }));
    expect(screen.getByText('src/file-29.ts')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows five or fewer paths in full with no button', () => {
    render(<PlanItemText item={`Add logging - files: ${paths(5).join(', ')} - proof: p`} />);

    expect(screen.getByText('src/file-4.ts')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows an item without files as its text', () => {
    render(<PlanItemText item="Send the mail" />);

    expect(screen.getByText('Send the mail')).toBeVisible();
  });
});

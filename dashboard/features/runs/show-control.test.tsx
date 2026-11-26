import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShowControl } from './show-control';

describe('ShowControl', () => {
  it('shows a placeholder in place of each count until the counts arrive', () => {
    render(<ShowControl part="active" counts={null} onPart={vi.fn()} />);

    expect(screen.getAllByTestId('count-placeholder')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /^Active/ })).not.toHaveTextContent(/\d/);
  });

  it('shows each count with its label once they are there', () => {
    render(<ShowControl part="active" counts={{ active: 3, done: 5, all: 8 }} onPart={vi.fn()} />);

    expect(screen.queryByTestId('count-placeholder')).toBeNull();
    expect(screen.getByRole('button', { name: 'Active 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 8' })).toBeInTheDocument();
  });

  it('asks for the part that was clicked', async () => {
    const onPart = vi.fn();
    render(<ShowControl part="active" counts={{ active: 3, done: 5, all: 8 }} onPart={onPart} />);

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Done 5' }));

    expect(onPart).toHaveBeenCalledWith('done');
  });
});

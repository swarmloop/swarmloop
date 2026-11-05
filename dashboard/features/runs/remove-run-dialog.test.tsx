import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { RemoveRunDialog } from './remove-run-dialog';

function dialog(overrides: Partial<ComponentProps<typeof RemoveRunDialog>> = {}) {
  const props = {
    run: runSummary(),
    removing: false,
    error: null,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<RemoveRunDialog {...props} />);
  return props;
}

describe('RemoveRunDialog', () => {
  it('titles the dialog with the run name', () => {
    dialog();

    expect(screen.getByRole('heading', { name: 'Remove Run one?' })).toBeInTheDocument();
  });

  it('closes on Cancel and confirms on Remove', async () => {
    const user = userEvent.setup();
    const props = dialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while the run is being removed', () => {
    dialog({ removing: true });

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('shows the error text', () => {
    dialog({ error: 'remove refused' });

    expect(screen.getByText('remove refused')).toBeInTheDocument();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { RemoveRunDialog } from './remove-run-dialog';

function dialog(overrides: Partial<ComponentProps<typeof RemoveRunDialog>> = {}) {
  const props = {
    run: runSummary(),
    onClose: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<RemoveRunDialog {...props} />);
  return props;
}

describe('RemoveRunDialog', () => {
  it('titles the dialog with the run name', () => {
    dialog();

    expect(screen.getByRole('heading', { name: `Remove run ${runSummary().title}?` })).toBeInTheDocument();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
  });

  it('closes on Cancel and confirms on Remove', async () => {
    const user = userEvent.setup({ delay: null });
    const props = dialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove run' }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(2));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while the run is being removed', async () => {
    const user = userEvent.setup({ delay: null });
    dialog({ onConfirm: () => new Promise(() => undefined) });

    await user.click(screen.getByRole('button', { name: 'Remove run' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove run/ })).toBeDisabled();
  });

  it('shows the error text', async () => {
    const user = userEvent.setup({ delay: null });
    const props = dialog({ onConfirm: vi.fn().mockRejectedValue(new Error('remove refused')) });

    await user.click(screen.getByRole('button', { name: 'Remove run' }));

    expect(await screen.findByText('remove refused')).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

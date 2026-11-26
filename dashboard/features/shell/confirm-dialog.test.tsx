import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mediaWidth } from '../../test/viewport';
import { ConfirmDialog } from './confirm-dialog';

function confirm(onConfirm: () => Promise<unknown> = () => Promise.resolve(), tone: 'danger' | 'primary' = 'danger') {
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Stop run-1?"
      body="The agent stops now."
      verb="Stop"
      tone={tone}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return onClose;
}

describe('ConfirmDialog', () => {
  it('shows the title, the body, then Cancel and the verb button', () => {
    confirm();

    const dialog = screen.getByRole('dialog', { name: 'Stop run-1?' });
    expect(dialog).toHaveTextContent('The agent stops now.');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel', 'Stop']);
  });

  it('draws the verb button in the error color for danger and in the primary color otherwise', () => {
    const { unmount } = render(
      <ConfirmDialog open title="t" body="b" verb="Stop" tone="danger" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveClass('MuiButton-containedError');
    unmount();
    render(<ConfirmDialog open title="t" body="b" verb="Go" tone="primary" onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('MuiButton-containedPrimary');
  });

  it('starts with the focus on Cancel, so Enter and Escape never confirm', async () => {
    const user = userEvent.setup({ delay: null });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = confirm(onConfirm);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape without confirming', async () => {
    const user = userEvent.setup({ delay: null });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = confirm(onConfirm);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows progress and disables both buttons while the action runs, and closes on success', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: () => void = () => undefined;
    const onClose = confirm(() => new Promise<void>((resolve) => (finish = resolve)));

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeDisabled();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open on an error, says it in words and tries again with the verb button', async () => {
    const user = userEvent.setup({ delay: null });
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('the host said no')).mockResolvedValue(undefined);
    const onClose = confirm(onConfirm);

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('the host said no')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe('ConfirmDialog at 375 px', () => {
  mediaWidth(375);

  it('is full screen with no fixed width and wrapping actions', () => {
    confirm();

    const paper = screen.getByRole('dialog').closest('.MuiDialog-paper')!;
    expect(paper).toHaveClass('MuiDialog-paperFullScreen');
    expect(getComputedStyle(paper).width).not.toBe('440px');
    expect(getComputedStyle(screen.getByRole('button', { name: 'Stop' }).parentElement!).flexWrap).toBe('wrap');
  });
});

describe('ConfirmDialog at 1280 px', () => {
  mediaWidth(1280);

  it('is 440 px wide, not full screen, and its actions do not wrap', () => {
    confirm();

    const paper = screen.getByRole('dialog').closest('.MuiDialog-paper')!;
    expect(paper).not.toHaveClass('MuiDialog-paperFullScreen');
    expect(getComputedStyle(paper).width).toBe('440px');
    expect(getComputedStyle(screen.getByRole('button', { name: 'Stop' }).parentElement!).flexWrap).not.toBe('wrap');
  });
});

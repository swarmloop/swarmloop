import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { TaskLine } from './task-line';

describe('TaskLine', () => {
  it('carries the whole run name on hover', async () => {
    const name = 'a long run name '.repeat(10).trim();
    render(<TaskLine run={{ ...runSummary(), name }} selected={false} onOpen={vi.fn()} onRemove={vi.fn()} />);

    await userEvent.setup({ delay: null }).hover(screen.getByText(name));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
  });

  it('keeps the delete rendered but hidden and not focusable until hover or focus', async () => {
    const user = userEvent.setup({ delay: null });
    render(<TaskLine run={runSummary()} selected={false} onOpen={vi.fn()} onRemove={vi.fn()} />);
    const remove = screen.getByLabelText(/^Remove /);
    expect(remove).not.toBeVisible();
    expect(remove).toHaveAttribute('tabindex', '-1');

    const title = screen.getByText(runSummary().name);
    await user.hover(title);
    expect(remove).toBeVisible();
    expect(remove).toHaveAttribute('tabindex', '0');
    await user.unhover(title);
    expect(remove).not.toBeVisible();

    await user.tab();
    expect(remove).toBeVisible();
  });

  it('offers a ⋯ menu with Remove where there is no hover', async () => {
    const user = userEvent.setup({ delay: null });
    const onRemove = vi.fn();
    const run = runSummary();
    const touch = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(hover: none)',
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    try {
      render(<TaskLine run={run} selected={false} onOpen={vi.fn()} onRemove={onRemove} />);

      await user.click(screen.getByRole('button', { name: `More actions for ${run.name}` }));
      await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

      expect(onRemove).toHaveBeenCalledWith(run);
    } finally {
      touch.mockRestore();
    }
  });

  it('shows the turning ring for a working task row', () => {
    render(<TaskLine run={runSummary()} selected={false} onOpen={vi.fn()} onRemove={vi.fn()} />);

    const icon = screen.getByRole('img', { name: 'Working' });
    expect(icon.querySelector('path')).not.toBeNull();
    expect(icon.querySelector('[data-testid="AutorenewIcon"]')).toBeNull();
  });
});

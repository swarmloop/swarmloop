import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { RunRow } from './run-row';

function row(backlog?: { name: string; milestone: number | null }) {
  const onOpen = vi.fn();
  const run = { ...runSummary(), ...(backlog ? { backlog } : {}) };
  render(<RunRow run={run} selected={false} now={0} onOpen={onOpen} onRemove={vi.fn()} />);
  return { onOpen, run };
}

describe('RunRow backlog label', () => {
  it('shows the label as a link to the backlog', () => {
    row({ name: 'swarmloop', milestone: 3 });

    const link = screen.getByRole('link', { name: 'Open backlog swarmloop' });
    expect(link).toHaveTextContent('swarmloop · M3');
    expect(link).toHaveAttribute('href', '/backlogs/swarmloop');
  });

  it('opens the backlog, not the run, when the label is clicked, and the run when the row is', async () => {
    const user = userEvent.setup({ delay: null });
    const { onOpen, run } = row({ name: 'swarmloop', milestone: 3 });

    await user.click(screen.getByRole('link'));
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByText(run.title));
    expect(onOpen).toHaveBeenCalledWith(run.key);
  });

  it('shows no label on a run without a backlog', () => {
    row();

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

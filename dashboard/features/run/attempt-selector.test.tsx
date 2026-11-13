import { render, screen, within } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepView, visitView } from '../../test/fixtures';
import { StepHeader } from './flow/step-detail/step-header';
import { withLog } from './step-view';
import type { StepView } from '@contract/api';

function visits(stored: number): StepView['visits'] {
  return Array.from({ length: stored }, (_, index) => visitView({ id: index + 1, attempt: index + 1, status: 'done' }));
}

function header(view: StepView, attempt: number) {
  return (
    <StepHeader
      step="implement"
      view={view}
      attempt={attempt}
      setAttempt={vi.fn()}
      follow={{ current: true }}
      attempts={view.visits.length}
      visit={view.visits[attempt]}
      label="running"
      shownDuration={0}
      shownAttempt={attempt + 1}
      problemId={null}
      problemCount={0}
    />
  );
}

afterEach(() => vi.restoreAllMocks());

describe('AttemptSelector in the step header', () => {
  it('shows each attempt once while live updates arrive between fetches', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const running = (attempt: number) =>
      visitView({ id: -1, key: `live-implement-${attempt}`, attempt, status: 'running' });
    let view = stepView({ visits: [...visits(19), running(20)] });
    const { rerender } = render(header(withLog(view, 'first', []), 19));
    for (const body of ['second', 'third']) {
      view = withLog(view, body, []);
      rerender(header(view, 19));
    }
    view = stepView({ visits: [...visits(20), running(21)] });
    rerender(header(withLog(view, 'fourth', []), 20));
    view = withLog(view, 'fifth', []);
    rerender(header(view, 20));

    expect(view.visits).toHaveLength(21);
    for (let attempt = 14; attempt <= 21; attempt += 1) {
      expect(screen.getAllByRole('button', { name: String(attempt) })).toHaveLength(1);
    }
    expect(screen.queryByRole('button', { name: '13' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Earlier (13)' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem')).toHaveLength(13);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/);
  });

  it('lists as many visit buttons as the badge counts for a step sent back by checks, while its check is rerun', () => {
    const sentBack = visitView({ id: 1, attempt: 1, status: 'waiting' });
    const rerun = visitView({ id: -1, key: 'live-implement-2', attempt: 2, status: 'running' });
    const view = withLog(stepView({ visits: [sentBack, rerun] }), 'rerunning the check', []);
    const badge = 2;

    render(header(view, 1));

    expect(screen.getAllByRole('button', { name: /^\d+$/ })).toHaveLength(badge);
    expect(view.visits).toHaveLength(badge);
  });

  it('colors a visit that sent work back as returned and outlines the selected one instead of filling it', () => {
    const sentBack = visitView({ id: 1, attempt: 1, status: 'waiting' });
    const passed = visitView({ id: 2, attempt: 2, status: 'done' });
    const view = stepView({ visits: [sentBack, passed] });

    render(
      <StepHeader
        step="checks"
        view={view}
        attempt={0}
        setAttempt={vi.fn()}
        follow={{ current: true }}
        attempts={2}
        visit={view.visits[0]}
        label="returned"
        shownDuration={0}
        shownAttempt={1}
        problemId={null}
        problemCount={0}
      />,
    );

    const first = screen.getByRole('button', { name: '1' });
    expect(first).toHaveStyle({ color: 'var(--chart-returns)', fontWeight: '700' });
    expect(first).toHaveClass('MuiButton-outlined');
    expect(screen.getByRole('button', { name: '2' })).toHaveClass('MuiButton-text');
    expect(first).not.toHaveStyle({ color: createTheme().palette.error.main });
  });

  it('keeps a selected earlier attempt visible as a button', () => {
    render(header(stepView({ visits: visits(12) }), 1));

    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Earlier (4)' })).toBeInTheDocument();
  });

  it('scrolls inside its own box and never widens the panel', () => {
    render(header(stepView({ visits: visits(12) }), 11));

    const strip = screen.getByRole('button', { name: '12' }).parentElement;
    expect(strip).toHaveStyle({ overflowX: 'auto', minWidth: '0' });
  });
});

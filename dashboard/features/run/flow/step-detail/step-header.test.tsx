import { render, screen } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { stepView, visitView } from '../../../../test/fixtures';
import { StepHeader } from './step-header';

function header(overrides: Partial<ComponentProps<typeof StepHeader>> = {}) {
  const view = stepView({ visits: [visitView({ id: 1, attempt: 1 }), visitView({ id: 2, attempt: 2 })] });
  const props = {
    step: 'implement',
    view,
    attempt: 1,
    setAttempt: vi.fn(),
    follow: { current: true },
    attempts: 2,
    visit: view.visits[1],
    label: 'done',
    shownDuration: 1000,
    shownAttempt: 2,
    problemId: null,
    problemCount: 0,
    ...overrides,
  };
  render(<StepHeader {...props} />);
  return props;
}

describe('StepHeader', () => {
  it('shows the step label', () => {
    header();

    expect(screen.getByText('implement')).toBeInTheDocument();
  });

  it('says the step has not run when there is no visit', () => {
    header({ view: stepView({ visits: [] }), visit: undefined, attempt: 0, attempts: 0 });

    expect(screen.getByText('This step has not run.')).toBeInTheDocument();
  });

  it('shows how long the run waited before a visit, with the slowest command, over 30 seconds', () => {
    const view = stepView({ visits: [visitView({ preparedMs: 338_000 })] });
    header({
      view,
      visit: view.visits[0],
      attempt: 0,
      attempts: 1,
      slowestPrepared: { command: 'git add -A', ms: 330_000 },
    });

    expect(screen.getByText(/prepared in 5m 38s · slowest: git add -A 5m 30s/)).toBeInTheDocument();
  });

  it('shows no wait for a visit that waited 30 seconds or less', () => {
    const view = stepView({ visits: [visitView({ preparedMs: 10_000 })] });
    header({ view, visit: view.visits[0], attempt: 0, attempts: 1 });

    expect(screen.queryByText(/prepared in/)).toBeNull();
  });

  it('says the step is preparing, not that it has not run, while the run works on it', () => {
    header({ view: stepView({ visits: [] }), visit: undefined, attempt: 0, attempts: 0, preparing: true });

    expect(screen.queryByText('This step has not run.')).toBeNull();
    expect(screen.getByText('preparing')).toBeInTheDocument();
  });

  it('selects an attempt and sets follow to whether it is the latest', async () => {
    const user = userEvent.setup();
    const props = header();

    await user.click(screen.getByRole('button', { name: '1' }));
    expect(props.setAttempt).toHaveBeenLastCalledWith(0);
    expect(props.follow.current).toBe(false);

    await user.click(screen.getByRole('button', { name: '2' }));
    expect(props.setAttempt).toHaveBeenLastCalledWith(1);
    expect(props.follow.current).toBe(true);
  });

  it('labels the resume button with the label it is given', () => {
    header({ onResume: vi.fn(), resumeLabel: 'Re-run CI' });

    expect(screen.getByRole('button', { name: 'Re-run CI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('calls onReplay and onResume from their buttons', async () => {
    const user = userEvent.setup();
    const props = header({ onReplay: vi.fn(), onResume: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'Run again' }));
    await user.click(screen.getByRole('button', { name: 'Resume' }));

    expect(props.onReplay).toHaveBeenCalledTimes(1);
    expect(props.onResume).toHaveBeenCalledTimes(1);
  });

  it('shows the kind, model and mode of an agent step', () => {
    header({
      view: stepView({
        descriptor: {
          name: 'implement',
          kind: 'agent',
          agent: { runtime: 'claude', model: 'opus', mode: 'agent', tools: 'write', timeLimitMs: 1, session: 'fresh' },
        },
      }),
    });

    expect(screen.getByText('claude · opus')).toBeInTheDocument();
    expect(screen.queryByText(/agent/)).not.toBeInTheDocument();
  });

  it('shows the reviewers of code-review', () => {
    header({
      view: stepView({
        descriptor: {
          name: 'code-review',
          kind: 'agent',
          reviewers: [
            { name: 'quality', model: 'opus', mode: 'agent' },
            { name: 'security', model: 'opus', mode: 'agent' },
          ],
        },
      }),
    });

    expect(screen.getByText('reviewers: quality, security')).toBeInTheDocument();
  });

  it('links to the first problem of the step in the error color, with the words of the chip', async () => {
    header({ problemId: 'event-7', problemCount: 2 });
    const target = document.createElement('div');
    target.id = 'problem-event-7';
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    document.body.append(target);

    const link = screen.getByRole('link', { name: '2 problems' });
    await userEvent.click(link);

    expect(link).toHaveAttribute('href', '#problem-event-7');
    expect(link).toHaveStyle({ color: createTheme().palette.error.main });
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    target.remove();
  });

  it('says server for a server step and names no mode next to the kind', () => {
    header({ view: stepView({ descriptor: { name: 'commit', kind: 'server' } }) });

    expect(screen.getByText('server')).toBeInTheDocument();
    expect(screen.queryByText(/\bagent\b/)).not.toBeInTheDocument();
  });

  it('shows returned as the status word of a visit that sent work back', () => {
    const view = stepView({ visits: [visitView({ attempt: 1, status: 'waiting' })] });
    header({ step: 'checks', view, visit: view.visits[0], attempt: 0, attempts: 1, label: 'returned' });

    expect(screen.getByText(/returned/)).toBeInTheDocument();
  });

  it('has no problem link when the step recorded none', () => {
    header();

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

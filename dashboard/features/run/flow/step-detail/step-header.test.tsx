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

/** Matches the line of a step's runtime, model and effort, whose model id sits in its own element. */
const modelLine = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === 'P' && element.textContent === text;

describe('StepHeader', () => {
  it('shows the step label', () => {
    header();

    expect(screen.getByText('implement')).toBeInTheDocument();
  });

  it('shows a server step with status, time, passed and slowest only: no cost, tokens, cpu or model line', () => {
    const view = stepView({
      descriptor: { name: 'checks', kind: 'server' },
      visits: [visitView({ usd: 1.5, tokensIn: 9, tokensOut: 8, cpuPeak: 70 })],
    });
    header({
      view,
      visit: view.visits[0],
      attempt: 0,
      attempts: 1,
      commands: { passed: 8, total: 12, slowest: { command: 'unit tests', ms: 65_000 } },
    });

    expect(screen.getByText('8/12 passed · slowest: unit tests 1m 5s')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/ in$| out$/)).toBeNull();
    expect(screen.queryByText(/cpu|mem /)).toBeNull();
    expect(screen.queryByText('server')).toBeNull();
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
    const user = userEvent.setup({ delay: null });
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

  it('keeps a lone Run again contained', () => {
    header({ onReplay: vi.fn() });

    expect(screen.getByRole('button', { name: 'Run again' })).toHaveClass('MuiButton-contained');
  });

  it('shows the peak memory of a server step when it was measured', () => {
    const view = stepView({
      descriptor: { name: 'checks', kind: 'server' },
      visits: [visitView({ memPeak: 3 * 1024 * 1024 })],
    });
    header({ view, visit: view.visits[0], attempt: 0, attempts: 1 });

    expect(screen.getByText('3 MB')).toBeInTheDocument();
  });

  it('calls onReplay and onResume from their buttons', async () => {
    const user = userEvent.setup({ delay: null });
    const props = header({ onReplay: vi.fn(), onResume: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'Run again' }));
    await user.click(screen.getByRole('button', { name: 'Resume' }));

    expect(props.onReplay).toHaveBeenCalledTimes(1);
    expect(props.onResume).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
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

    expect(screen.getByText(modelLine('claude · opus'))).toBeInTheDocument();
    expect(screen.queryByText(/agent/)).not.toBeInTheDocument();
  });

  describe('effort', () => {
    const claude = {
      name: 'implement',
      kind: 'agent' as const,
      agent: {
        runtime: 'claude',
        model: 'claude-opus-5-5',
        mode: 'agent' as const,
        tools: 'write' as const,
        timeLimitMs: 1,
        session: 'fresh' as const,
      },
    };
    const shown = (fields: Parameters<typeof visitView>[0]) => {
      const view = stepView({ descriptor: claude, visits: [visitView(fields)] });
      header({ view, visit: view.visits[0], attempt: 0, attempts: 1 });
    };

    it('shows the effort after the model', () => {
      shown({ effort: 'high' });

      expect(screen.getByText(modelLine('claude · claude-opus-5-5 · high'))).toBeInTheDocument();
    });

    it('marks an effort the epic raised', () => {
      shown({ effort: 'xhigh', effortNote: 'epic' });

      expect(screen.getByText(modelLine('claude · claude-opus-5-5 · xhigh (epic)'))).toBeInTheDocument();
    });

    it('adds nothing for a capped note', () => {
      shown({ effort: 'max', effortNote: 'capped:max' });

      expect(screen.getByText(modelLine('claude · claude-opus-5-5 · max'))).toBeInTheDocument();
    });
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
    await userEvent.setup({ delay: null }).click(link);

    expect(link).toHaveAttribute('href', '#problem-event-7');
    expect(link).toHaveStyle({ color: createTheme().palette.error.main });
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    target.remove();
  });

  it('says server for a server step and names no mode next to the kind', () => {
    header({ view: stepView({ descriptor: { name: 'commit', kind: 'server' } }) });

    expect(screen.queryByText('server')).not.toBeInTheDocument();
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

  it('offers Retry on a failed step and no button on a returned one', () => {
    const onReplay = vi.fn();
    header({ onReplay, label: 'failed' });

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers no way to run a returned step again', () => {
    header({ onReplay: vi.fn(), label: 'returned' });

    expect(screen.queryByRole('button', { name: /Retry|Run again/ })).toBeNull();
  });

  it('shows a returned attempt number in the error color with the undo icon', () => {
    const view = stepView({
      visits: [visitView({ id: 1, attempt: 1, status: 'waiting' }), visitView({ id: 2, attempt: 2, status: 'done' })],
    });
    header({ step: 'checks', view, visit: view.visits[0], attempt: 0, label: 'returned' });

    const first = screen.getByRole('button', { name: '1' });
    expect(first).toHaveStyle({ color: createTheme().palette.error.main });
    expect(first.querySelector('[data-testid="UndoIcon"]')).not.toBeNull();
  });

  it('keeps the model id in mono and the rest of the line in the UI font', () => {
    const view = stepView({
      descriptor: {
        name: 'implement',
        kind: 'agent',
        agent: { runtime: 'claude', model: 'opus', mode: 'agent', tools: 'write', timeLimitMs: 1, session: 'fresh' },
      },
    });
    header({ view, visit: view.visits[0], attempt: 0, attempts: 1 });

    expect(screen.getByText('opus')).toHaveStyle({ fontFamily: 'var(--font-mono)' });
    expect(screen.getByText('implement')).not.toHaveStyle({ fontFamily: 'var(--font-mono)' });
  });
});

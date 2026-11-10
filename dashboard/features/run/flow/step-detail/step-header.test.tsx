import { render, screen } from '@testing-library/react';
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

    expect(screen.getByText('agent · opus · agent')).toBeInTheDocument();
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

    expect(screen.getByText('agent · reviewers: quality, security')).toBeInTheDocument();
  });

  it('links to the first problem of the step', () => {
    header({ problemId: 'event-7' });

    expect(screen.getByRole('link', { name: /Error/ })).toHaveAttribute('href', '#problem-event-7');
  });

  it('has no problem link when the step recorded none', () => {
    header();

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

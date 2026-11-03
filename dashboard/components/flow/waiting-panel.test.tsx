import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { resumeRun, sendAnswers } from '../../lib/endpoints';
import { flowView } from '../../test/fixtures';
import { WaitingPanel } from './waiting-panel';

vi.mock('../../lib/endpoints', () => ({ sendAnswers: vi.fn(), resumeRun: vi.fn() }));

function waitingFlow() {
  return flowView({
    status: 'waiting',
    resume: 'need-answers',
    items: [
      { kind: 'question', id: 'q1', label: 'Which database?', answer: '' },
      { kind: 'paste', id: 'p1', label: 'Config', answer: '' },
    ],
  });
}

describe('WaitingPanel', () => {
  it('enables Submit once every answer is filled, then posts the answers and calls onChange', async () => {
    const user = userEvent.setup();
    const next = flowView({ status: 'running', resume: 'running' });
    vi.mocked(sendAnswers).mockResolvedValue(next);
    const onChange = vi.fn();
    render(<WaitingPanel flow={waitingFlow()} onChange={onChange} />);

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Which database?' }), 'postgres');
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Config' }), 'port=5432');
    expect(submit).toBeEnabled();

    await user.click(submit);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(next));
    expect(sendAnswers).toHaveBeenCalledWith('run-1', {
      answers: [
        { kind: 'question', id: 'q1', body: 'postgres' },
        { kind: 'paste', id: 'p1', body: 'port=5432' },
      ],
    });
  });

  it('shows the error when the answers are rejected', async () => {
    const user = userEvent.setup();
    vi.mocked(sendAnswers).mockRejectedValue(new Error('answers rejected'));
    render(<WaitingPanel flow={waitingFlow()} onChange={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Which database?' }), 'postgres');
    await user.type(screen.getByRole('textbox', { name: 'Config' }), 'port=5432');

    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('answers rejected')).toBeInTheDocument();
  });

  it('offers Resume without items when the run is ready, and posts it', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeRun).mockResolvedValue({});
    const onChange = vi.fn();
    render(<WaitingPanel flow={flowView({ status: 'failed', resume: 'ready' })} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', resume: 'running' })),
    );
    expect(resumeRun).toHaveBeenCalledWith('run-1');
  });

  it('disables Resume while the run is not ready', () => {
    render(<WaitingPanel flow={flowView({ status: 'failed', resume: 'running' })} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
  });

  it('hides the actions when the run is blocked', () => {
    render(<WaitingPanel flow={flowView({ status: 'blocked', resume: 'blocked' })} onChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });
});

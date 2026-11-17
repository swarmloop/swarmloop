import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { resumeRun, sendAnswers } from '../../../lib/endpoints';
import { flowView } from '../../../test/fixtures';
import { WaitingPanel } from './waiting-panel';

vi.mock('../../../lib/endpoints', () => ({ sendAnswers: vi.fn(), resumeRun: vi.fn() }));

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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
    vi.mocked(sendAnswers).mockRejectedValue(new Error('answers rejected'));
    render(<WaitingPanel flow={waitingFlow()} onChange={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Which database?' }), 'postgres');
    await user.type(screen.getByRole('textbox', { name: 'Config' }), 'port=5432');

    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('answers rejected')).toBeInTheDocument();
  });

  it('offers Resume without items when the run is ready, and posts it', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(resumeRun).mockResolvedValue({});
    const onChange = vi.fn();
    render(<WaitingPanel flow={flowView({ status: 'failed', resume: 'ready' })} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', resume: 'running' })),
    );
    expect(resumeRun).toHaveBeenCalledWith('run-1');
  });

  it('shows the reason on top, the job names as a list and a Re-run CI action when CI did not run', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(resumeRun).mockResolvedValue({});
    const line = 'CI_NOT_RUN: CI did not run server-test, autofix: spending limit https://ci.example/9';
    render(
      <WaitingPanel
        flow={flowView({
          status: 'blocked',
          resume: 'ready',
          reason: `${line}\njob: server-test\njob: autofix\n`,
          stateReason: { code: 'CI_NOT_RUN', message: line },
        })}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['server-test', 'autofix']);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Re-run CI' }));
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

  describe('a question in parts', () => {
    const asked = '2026-11-15T07:11:43.444Z';
    const points = Array.from({ length: 50 }, (_, index) => `${index + 1}. Do ${index + 1} is met`);
    const parts = {
      decide: 'Is the requirements review right that Do 4 is missing?',
      sides: [
        { who: 'requirements', text: 'Do 4 is missing: the skill does not point to project-base.md' },
        { who: 'implement', text: 'Implement did not answer this point' },
      ],
      full: points.join('\n'),
      askedAt: asked,
    };
    const question = 'requirements still returns: ... Which holds? (asked 2026-11-15T07:11:43.444Z)';
    const partsFlow = () =>
      flowView({
        status: 'waiting',
        resume: 'need-answers',
        actions: ['answer'],
        items: [{ kind: 'question', id: question, label: question, answer: '', parts }],
      });

    it('reads as a question: what is decided, the two sides, the whole review folded as a list, local time', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(sendAnswers).mockResolvedValue(flowView());
      const { container } = render(<WaitingPanel flow={partsFlow()} onChange={vi.fn()} />);

      expect(screen.getByText(parts.decide)).toBeInTheDocument();
      expect(screen.getByText(/Do 4 is missing: the skill/)).toBeInTheDocument();
      expect(screen.getByText('Implement did not answer this point')).toBeInTheDocument();
      expect(screen.queryByText(/Do 5 is met/)).not.toBeVisible();
      const details = container.querySelector('details') as HTMLDetailsElement;
      expect(details.querySelector('summary')?.textContent).toBe('Show the whole review');
      expect(details.querySelectorAll('li')).toHaveLength(50);
      expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

      await user.type(screen.getByRole('textbox', { name: question }), 'keep it');
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      expect(sendAnswers).toHaveBeenCalledWith('run-1', {
        answers: [{ kind: 'question', id: question, body: 'keep it' }],
      });
    });

    it('renders the label of a question without parts, and a list in the reason as a list', () => {
      render(
        <WaitingPanel
          flow={flowView({
            status: 'waiting',
            reason: '- first\n- second',
            items: [{ kind: 'question', id: 'q', label: 'Which **database**?', answer: '' }],
          })}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByText('database').tagName).toBe('STRONG');
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['first', 'second']);
    });
  });
});

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, runLog } from '../lib/api';
import { receive } from '../test/fake-socket';
import { stepView, visitView } from '../test/fixtures';
import { useStep } from './use-step';

vi.mock('../lib/api', () => ({ api: vi.fn(), runLog: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

function Probe({ step }: { step: string }) {
  const { view, error } = useStep('run-1', step, false, 'revision', 0);
  const log = view?.visits.at(-1)?.documents.find((item) => item.kind === 'log')?.body;
  return (
    <div>
      {log ? <pre>{log}</pre> : null}
      {error ? <p>{error}</p> : null}
    </div>
  );
}

function runningStep(body: string) {
  return stepView({
    visits: [
      visitView({
        status: 'running',
        documents: [{ kind: 'log', attempt: 1, body, createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    ],
  });
}

describe('useStep', () => {
  it('shows the step from GET on mount', async () => {
    vi.mocked(api).mockResolvedValue(runningStep('first line'));

    render(<Probe step="implement" />);

    expect(await screen.findByText('first line')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/runs/run-1/steps/implement');
  });

  it('merges a log event for the watched step and ignores other steps', async () => {
    vi.mocked(api).mockResolvedValue(runningStep('first line'));
    render(<Probe step="implement" />);
    await screen.findByText('first line');

    act(() => receive('log', { key: 'run-1', step: 'plan', body: 'other step' }));
    expect(screen.queryByText('other step')).not.toBeInTheDocument();

    act(() => receive('log', { key: 'run-1', step: 'implement', body: 'second line' }));
    expect(await screen.findByText('second line')).toBeInTheDocument();
    expect(screen.queryByText('first line')).not.toBeInTheDocument();
  });

  it('reads a code-review step from its log when the step request fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('step is gone'));
    vi.mocked(runLog).mockResolvedValue('reviewer notes');

    render(<Probe step="code-review-security" />);

    expect(await screen.findByText('reviewer notes')).toBeInTheDocument();
    expect(runLog).toHaveBeenCalledWith('run-1', 'code-review-security');
  });
});

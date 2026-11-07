import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { getRunLog, getStep } from '../../lib/endpoints';
import { receive } from '../../test/fake-socket';
import { stepView, visitView } from '../../test/fixtures';
import { LiveBridgeProvider, useLiveActions } from '../shell';
import { useStep } from './use-step';

vi.mock('../../lib/endpoints', () => ({ getStep: vi.fn(), getRunLog: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

function Watching({ children }: { children: ReactNode }) {
  const { watchRun } = useLiveActions();
  useEffect(() => {
    watchRun('run-1');
  }, [watchRun]);
  return <>{children}</>;
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <LiveBridgeProvider>
      <Watching>{children}</Watching>
    </LiveBridgeProvider>
  );
}

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

function Counting({ revision }: { revision: string }) {
  const { view } = useStep('run-1', 'implement', false, revision, 0);
  return <p>{view ? `attempts ${view.visits.map((item) => item.attempt).join(',')}` : 'loading'}</p>;
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
    vi.mocked(getStep).mockResolvedValue(runningStep('first line'));

    render(<Probe step="implement" />, { wrapper: Wrapper });

    expect(await screen.findByText('first line')).toBeInTheDocument();
    expect(getStep).toHaveBeenCalledWith('run-1', 'implement');
  });

  it('merges a log event for the watched step and ignores other steps', async () => {
    vi.mocked(getStep).mockResolvedValue(runningStep('first line'));
    render(<Probe step="implement" />, { wrapper: Wrapper });
    await screen.findByText('first line');

    act(() => receive('log', { key: 'run-1', step: 'plan', body: 'other step' }));
    expect(screen.queryByText('other step')).not.toBeInTheDocument();

    act(() => receive('log', { key: 'run-1', step: 'implement', body: 'second line' }));
    expect(await screen.findByText('second line')).toBeInTheDocument();
    expect(screen.queryByText('first line')).not.toBeInTheDocument();
  });

  it('reads a code-review step from its log when the step request fails', async () => {
    vi.mocked(getStep).mockRejectedValue(new Error('step is gone'));
    vi.mocked(getRunLog).mockResolvedValue('reviewer notes');

    render(<Probe step="code-review-security" />, { wrapper: Wrapper });

    expect(await screen.findByText('reviewer notes')).toBeInTheDocument();
    expect(getRunLog).toHaveBeenCalledWith('run-1', 'code-review-security');
  });
  it('shows the message of a rejected 404 ApiError', async () => {
    vi.mocked(getStep).mockRejectedValue(new ApiError(404, 'step is gone'));

    render(<Probe step="implement" />, { wrapper: Wrapper });

    expect(await screen.findByText('step is gone')).toBeInTheDocument();
  });

  it('shows no next attempt when a refetch already holds the attempt of a stale log', async () => {
    vi.mocked(getStep).mockResolvedValueOnce(runningStep('first line'));
    const { rerender } = render(<Counting revision="1" />, { wrapper: Wrapper });
    await screen.findByText('attempts 1');

    let finish: (value: ReturnType<typeof stepView>) => void = () => undefined;
    vi.mocked(getStep).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    rerender(<Counting revision="2" />);
    act(() => receive('log', { key: 'run-1', step: 'implement', body: 'last output' }));
    await act(async () => finish(stepView({ visits: [visitView({ status: 'done' })] })));

    expect(await screen.findByText('attempts 1')).toBeInTheDocument();
  });
});

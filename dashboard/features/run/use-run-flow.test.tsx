import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { getFlow, getRunLog, replayStep, stopRun } from '../../lib/endpoints';
import { emitted, receive } from '../../test/fake-socket';
import { flowView } from '../../test/fixtures';
import { reviewLog } from '../../test/review-log';
import { LiveBridgeProvider } from '../shell';
import { useRunFlow } from './use-run-flow';

vi.mock('../../lib/endpoints', () => ({ getFlow: vi.fn(), getRunLog: vi.fn(), stopRun: vi.fn(), replayStep: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

function Probe({ runKey }: { runKey: string }) {
  const { flow, error } = useRunFlow(runKey);
  return (
    <div>
      {flow ? <p>{flow.name}</p> : null}
      {error ? <p>{error}</p> : null}
    </div>
  );
}

describe('useRunFlow', () => {
  it('keeps pending review probes tied to their original effect', async () => {
    const step = 'code-review-quality';
    const reviewing = flowView({
      name: 'Original review',
      currentStep: 'code-review',
      phases: [{ phase: 'code-review', steps: [{ name: step, status: 'running', current: true, attempts: 0 }] }],
    });
    let finish: ((raw: string | null) => void) | undefined;
    const pending = new Promise<string | null>((resolve) => {
      finish = resolve;
    });
    vi.mocked(getRunLog).mockResolvedValue(null).mockReturnValueOnce(pending);
    vi.mocked(getFlow)
      .mockResolvedValueOnce(reviewing)
      .mockResolvedValueOnce(flowView({ key: 'run-2', name: 'Other run' }))
      .mockResolvedValueOnce({ ...reviewing, name: 'Fresh review' });

    function ReviewProbe({ runKey }: { runKey: string }) {
      const { flow } = useRunFlow(runKey);
      return <p>{flow ? `${flow.name}: ${flow.phases[0].steps[0].status}` : 'Loading'}</p>;
    }

    const { rerender } = render(<ReviewProbe runKey="run-1" />, { wrapper: LiveBridgeProvider });
    await screen.findByText('Original review: running');
    act(() => receive('log', { key: 'run-1', step, body: 'working' }));
    rerender(<ReviewProbe runKey="run-2" />);
    await screen.findByText('Other run: running');
    rerender(<ReviewProbe runKey="run-1" />);
    await screen.findByText('Fresh review: running');

    await act(async () => {
      finish?.(reviewLog('return'));
      await pending;
    });

    expect(screen.getByText('Fresh review: running')).toBeInTheDocument();
  });

  it('applies the flow from GET /runs/:key on mount', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ name: 'Flow one' }));

    render(<Probe runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('Flow one')).toBeInTheDocument();
    expect(getFlow).toHaveBeenCalledWith('run-1');
  });

  it('applies a flow event for the same run', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ name: 'Flow one' }));
    render(<Probe runKey="run-1" />, { wrapper: LiveBridgeProvider });
    await screen.findByText('Flow one');

    act(() => receive('flow', flowView({ name: 'Flow two' })));

    expect(await screen.findByText('Flow two')).toBeInTheDocument();
  });

  it('ignores a flow event for another run', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ name: 'Flow one' }));
    render(<Probe runKey="run-1" />, { wrapper: LiveBridgeProvider });
    await screen.findByText('Flow one');

    act(() => receive('flow', flowView({ key: 'run-2', name: 'Other run' })));

    expect(screen.queryByText('Other run')).not.toBeInTheDocument();
    expect(screen.getByText('Flow one')).toBeInTheDocument();
  });

  it('emits watch on mount and again on connect', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView());
    render(<Probe runKey="run-1" />, { wrapper: LiveBridgeProvider });
    await screen.findByText('Run one');

    expect(emitted).toHaveBeenNthCalledWith(1, 'watch', 'run-1');

    act(() => receive('connect'));

    expect(emitted).toHaveBeenNthCalledWith(2, 'watch', 'run-1');
  });

  it('shows the message when the load is rejected', async () => {
    vi.mocked(getFlow).mockRejectedValue(new Error('run is gone'));

    render(<Probe runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('run is gone')).toBeInTheDocument();
  });
  it('shows the message of a rejected 404 ApiError', async () => {
    vi.mocked(getFlow).mockRejectedValue(new ApiError(404, 'run not found'));

    render(<Probe runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('run not found')).toBeInTheDocument();
  });

  it('selects no step on a finished run, and still selects one the person picks', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done', currentStep: 'done' }));
    function SelectProbe() {
      const { flow, selected, selectStep } = useRunFlow('run-1');
      return (
        <div>
          <p>{flow ? `selected: ${selected ?? 'none'}` : 'Loading'}</p>
          <button onClick={() => selectStep('requirements')}>pick</button>
        </div>
      );
    }

    render(<SelectProbe />, { wrapper: LiveBridgeProvider });
    expect(await screen.findByText('selected: none')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'pick' }).click());

    expect(await screen.findByText('selected: requirements')).toBeInTheDocument();
  });

  it('loads the flow again on reload after a failed load', async () => {
    vi.mocked(getFlow).mockRejectedValueOnce(new Error('run is gone')).mockResolvedValue(flowView());
    function ReloadProbe() {
      const { flow, error, reload } = useRunFlow('run-1');
      return (
        <div>
          {flow ? <p>{flow.name}</p> : null}
          {error ? <p>{error}</p> : null}
          <button onClick={reload}>again</button>
        </div>
      );
    }

    render(<ReloadProbe />, { wrapper: LiveBridgeProvider });
    await screen.findByText('run is gone');
    act(() => screen.getByRole('button', { name: 'again' }).click());

    expect(await screen.findByText('Run one')).toBeInTheDocument();
    expect(screen.queryByText('run is gone')).not.toBeInTheDocument();
  });

  it('rejects a stop that failed and leaves the run as it was, and marks it stopped when the stop worked', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'running' }));
    vi.mocked(stopRun).mockRejectedValueOnce(new Error('stop refused')).mockResolvedValue({});
    const outcomes: string[] = [];
    function StopProbe() {
      const { flow, stopRun: stop } = useRunFlow('run-1');
      return (
        <div>
          {flow ? <p>{`status: ${flow.status}`}</p> : null}
          <button
            onClick={() =>
              void stop().then(
                () => outcomes.push('stopped'),
                (cause: Error) => outcomes.push(cause.message),
              )
            }
          >
            stop
          </button>
        </div>
      );
    }

    render(<StopProbe />, { wrapper: LiveBridgeProvider });
    await screen.findByText('status: running');
    await act(async () => screen.getByRole('button', { name: 'stop' }).click());
    expect(outcomes).toEqual(['stop refused']);
    expect(screen.getByText('status: running')).toBeInTheDocument();

    await act(async () => screen.getByRole('button', { name: 'stop' }).click());

    expect(outcomes).toEqual(['stop refused', 'stopped']);
    expect(await screen.findByText('status: failed')).toBeInTheDocument();
  });

  it('puts the upload ids in the replay body only when there are some', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done' }));
    vi.mocked(replayStep).mockResolvedValue({});
    function ReplayProbe() {
      const { flow, startReplay } = useRunFlow('run-1');
      return (
        <div>
          {flow ? <p>loaded</p> : null}
          <button onClick={() => void startReplay('implementation', 'p', ['planning'])}>plain</button>
          <button onClick={() => void startReplay('implementation', 'p', ['planning'], ['u1'])}>with files</button>
        </div>
      );
    }

    render(<ReplayProbe />, { wrapper: LiveBridgeProvider });
    await screen.findByText('loaded');
    await act(async () => screen.getByRole('button', { name: 'plain' }).click());
    await act(async () => screen.getByRole('button', { name: 'with files' }).click());

    expect(vi.mocked(replayStep).mock.calls).toEqual([
      ['run-1', 'implementation', { prompt: 'p', phases: ['planning'] }],
      ['run-1', 'implementation', { prompt: 'p', phases: ['planning'], attachments: ['u1'] }],
    ]);
  });
});

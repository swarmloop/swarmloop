import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, runLog } from '../lib/api';
import { emitted, receive } from '../test/fake-socket';
import { flowView } from '../test/fixtures';
import { useRunFlow } from './use-run-flow';

vi.mock('../lib/api', () => ({ api: vi.fn(), runLog: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

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
    vi.mocked(runLog).mockResolvedValue(null).mockReturnValueOnce(pending);
    vi.mocked(api)
      .mockResolvedValueOnce(reviewing)
      .mockResolvedValueOnce(flowView({ key: 'run-2', name: 'Other run' }))
      .mockResolvedValueOnce({ ...reviewing, name: 'Fresh review' });

    function ReviewProbe({ runKey }: { runKey: string }) {
      const { flow } = useRunFlow(runKey);
      return <p>{flow ? `${flow.name}: ${flow.phases[0].steps[0].status}` : 'Loading'}</p>;
    }

    const { rerender } = render(<ReviewProbe runKey="run-1" />);
    await screen.findByText('Original review: running');
    act(() => receive('log', { key: 'run-1', step, body: 'working' }));
    rerender(<ReviewProbe runKey="run-2" />);
    await screen.findByText('Other run: running');
    rerender(<ReviewProbe runKey="run-1" />);
    await screen.findByText('Fresh review: running');

    await act(async () => {
      finish?.('decision: return\nprocess exited 0');
      await pending;
    });

    expect(screen.getByText('Fresh review: running')).toBeInTheDocument();
  });

  it('applies the flow from GET /runs/:key on mount', async () => {
    vi.mocked(api).mockResolvedValue(flowView({ name: 'Flow one' }));

    render(<Probe runKey="run-1" />);

    expect(await screen.findByText('Flow one')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/runs/run-1');
  });

  it('applies a flow event for the same run', async () => {
    vi.mocked(api).mockResolvedValue(flowView({ name: 'Flow one' }));
    render(<Probe runKey="run-1" />);
    await screen.findByText('Flow one');

    act(() => receive('flow', flowView({ name: 'Flow two' })));

    expect(await screen.findByText('Flow two')).toBeInTheDocument();
  });

  it('ignores a flow event for another run', async () => {
    vi.mocked(api).mockResolvedValue(flowView({ name: 'Flow one' }));
    render(<Probe runKey="run-1" />);
    await screen.findByText('Flow one');

    act(() => receive('flow', flowView({ key: 'run-2', name: 'Other run' })));

    expect(screen.queryByText('Other run')).not.toBeInTheDocument();
    expect(screen.getByText('Flow one')).toBeInTheDocument();
  });

  it('emits watch on mount and again on connect', async () => {
    vi.mocked(api).mockResolvedValue(flowView());
    render(<Probe runKey="run-1" />);
    await screen.findByText('Run one');

    expect(emitted).toHaveBeenCalledWith('watch', 'run-1');
    expect(emitted).toHaveBeenCalledTimes(1);

    act(() => receive('connect'));

    expect(emitted).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveBeenLastCalledWith('watch', 'run-1');
  });

  it('shows the message when the load is rejected', async () => {
    vi.mocked(api).mockRejectedValue(new Error('run is gone'));

    render(<Probe runKey="run-1" />);

    expect(await screen.findByText('run is gone')).toBeInTheDocument();
  });
});

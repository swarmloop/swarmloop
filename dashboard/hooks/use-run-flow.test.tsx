import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
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

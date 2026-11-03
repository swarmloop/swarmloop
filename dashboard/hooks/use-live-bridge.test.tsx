import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitted, fakeSocket, receive, resetFakeSocket } from '../test/fake-socket';
import { flowView, runSummary } from '../test/fixtures';
import { LiveBridgeProvider, useLiveActions, useLiveBridge } from './use-live-bridge';

vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

let watch: (key: string | null) => void = () => undefined;

function Probe() {
  const { runs, flow, logs, connected } = useLiveBridge((snapshot) => snapshot);
  const { watchRun } = useLiveActions();
  useEffect(() => {
    watch = watchRun;
  }, [watchRun]);
  return (
    <div>
      <p>{connected ? 'live' : 'offline'}</p>
      {runs.map((run) => (
        <p key={run.key}>{run.name}</p>
      ))}
      {flow ? <p>flow {flow.name}</p> : null}
      {logs.map((entry) => (
        <p key={entry.step}>
          log {entry.step} {entry.body}
        </p>
      ))}
    </div>
  );
}

afterEach(() => {
  resetFakeSocket();
});

describe('useLiveBridge', () => {
  it('re-sends watch for the watched run on every connect', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });

    act(() => watch('r1'));
    expect(emitted).toHaveBeenCalledWith('watch', 'r1');
    expect(emitted).toHaveBeenCalledTimes(1);

    act(() => receive('connect'));
    act(() => receive('connect'));

    expect(emitted).toHaveBeenCalledTimes(3);
    expect(emitted).toHaveBeenLastCalledWith('watch', 'r1');
  });

  it('sends nothing on connect once no run is watched', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => watch('r1'));
    act(() => watch(null));
    emitted.mockClear();

    act(() => receive('connect'));

    expect(emitted).not.toHaveBeenCalled();
  });

  it('replaces the runs with a runs event', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });

    act(() => receive('runs', { runs: [runSummary()] }));
    expect(screen.getByText('Run one')).toBeInTheDocument();

    act(() => receive('runs', { runs: [{ ...runSummary(), key: 'run-2', name: 'Run two' }] }));
    expect(screen.getByText('Run two')).toBeInTheDocument();
    expect(screen.queryByText('Run one')).not.toBeInTheDocument();
  });

  it('keeps the flow of the watched run and ignores another one', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => watch('run-1'));

    act(() => receive('flow', flowView({ key: 'run-2', name: 'Other run' })));
    expect(screen.queryByText('flow Other run')).not.toBeInTheDocument();

    act(() => receive('flow', flowView({ name: 'Flow one' })));
    expect(screen.getByText('flow Flow one')).toBeInTheDocument();
  });

  it('keeps the latest log per step of the watched run and ignores another run', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => watch('run-1'));

    act(() => receive('log', { key: 'run-2', step: 'plan', body: 'other' }));
    act(() => receive('log', { key: 'run-1', step: 'plan', body: 'one' }));
    act(() => receive('log', { key: 'run-1', step: 'plan', body: 'two' }));

    expect(screen.queryByText('log plan other')).not.toBeInTheDocument();
    expect(screen.queryByText('log plan one')).not.toBeInTheDocument();
    expect(screen.getByText('log plan two')).toBeInTheDocument();
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(fakeSocket.listenerCount('runs')).toBe(1);

    unmount();

    for (const event of ['connect', 'disconnect', 'runs', 'flow', 'log']) {
      expect(fakeSocket.listenerCount(event)).toBe(0);
    }
  });
});

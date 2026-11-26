import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { emitted, fakeSocket, receive } from '../../test/fake-socket';
import { flowView, runSummary } from '../../test/fixtures';
import { doneItem } from '../../test/overview-fixtures';
import { runsPage } from '../../test/runs-page';
import { LiveBridgeProvider, useBacklogStamp, useLiveActions, useLiveBridge } from './use-live-bridge';
import type { RunSummary } from '@contract/api';

vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

let watch: (key: string | null) => void = () => undefined;
let setList: (runs: RunSummary[]) => void = () => undefined;

function Probe() {
  const { runs, loaded, flow, logs, events, connected, paused, statusStamp, backlogStamps } = useLiveBridge(
    (snapshot) => snapshot,
  );
  const shopStamp = useBacklogStamp('shop');
  const { watchRun, setRuns } = useLiveActions();
  useEffect(() => {
    watch = watchRun;
    setList = setRuns;
  }, [watchRun, setRuns]);
  return (
    <div>
      <p>{connected ? 'live' : 'offline'}</p>
      <p>{paused ? 'paused' : 'running'}</p>
      <p>stamp {statusStamp}</p>
      <p>backlogs {JSON.stringify(backlogStamps)}</p>
      <p>shop stamp {shopStamp}</p>
      <p>{loaded ? 'loaded' : 'not loaded'}</p>
      {runs.map((run) => (
        <p key={run.key}>{run.name}</p>
      ))}
      {flow ? <p>flow {flow.name}</p> : null}
      {events ? <p>events {events.seq}</p> : null}
      {logs.map((entry) => (
        <p key={entry.step}>
          log {entry.step} {entry.body}
        </p>
      ))}
    </div>
  );
}

describe('useLiveBridge', () => {
  it('re-sends watch for the watched run on every connect', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });

    act(() => watch('r1'));
    expect(emitted).toHaveBeenNthCalledWith(1, 'watch', 'r1');

    act(() => receive('connect'));
    act(() => receive('connect'));

    expect(emitted).toHaveBeenNthCalledWith(2, 'watch', 'r1');
    expect(emitted).toHaveBeenNthCalledWith(3, 'watch', 'r1');
  });

  it('counts every connect in the snapshot', () => {
    function Connects() {
      return <p>connects {useLiveBridge((snapshot) => snapshot.connects)}</p>;
    }
    render(<Connects />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('connects 0')).toBeInTheDocument();

    act(() => {
      receive('connect');
      receive('disconnect');
      receive('connect');
    });

    expect(screen.getByText('connects 2')).toBeInTheDocument();
  });

  it('sends nothing on connect once no run is watched', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => watch('r1'));
    act(() => watch(null));
    emitted.mockClear();

    act(() => receive('connect'));

    expect(emitted).not.toHaveBeenCalled();
  });

  it('keeps whether the server is paused from the server event', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('running')).toBeInTheDocument();

    act(() => receive('server', { paused: true }));
    expect(screen.getByText('paused')).toBeInTheDocument();

    act(() => receive('server', { paused: false }));
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('replaces the runs with a runs event', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });

    act(() => receive('runs', runsPage([runSummary()], { part: 'active' })));
    expect(screen.getByText('Run one')).toBeInTheDocument();

    act(() => receive('runs', runsPage([{ ...runSummary(), key: 'run-2', name: 'Run two' }], { part: 'active' })));
    expect(screen.getByText('Run two')).toBeInTheDocument();
    expect(screen.queryByText('Run one')).not.toBeInTheDocument();
  });

  it('is loaded after the first runs list from the socket or from the API', () => {
    const socket = render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('not loaded')).toBeInTheDocument();
    act(() => receive('runs', runsPage([], { part: 'active' })));
    expect(screen.getByText('loaded')).toBeInTheDocument();
    socket.unmount();

    render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('not loaded')).toBeInTheDocument();
    act(() => setList([]));
    expect(screen.getByText('loaded')).toBeInTheDocument();
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

    for (const event of ['connect', 'disconnect', 'runs', 'run', 'flow', 'log', 'backlog', 'done']) {
      expect(fakeSocket.listenerCount(event)).toBe(0);
    }
  });

  it('a run event replaces its rows in the held list and the list renders as after a full runs', () => {
    const counts = { active: 2, done: 0, all: 2 };
    const row = (key: string, name: string, createdAt: string): RunSummary => ({
      ...runSummary(),
      key,
      name,
      title: name,
      createdAt,
    });
    const first = row('r-1', 'First', '2026-11-02T10:00:00.000Z');
    const second = row('r-2', 'Second', '2026-11-01T10:00:00.000Z');
    const { unmount } = render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => receive('runs', { runs: [first, second], counts, otherMatches: 0, next: null }));

    act(() =>
      receive('run', { rows: [{ ...second, name: 'Second renamed', title: 'Second renamed' }], removed: [], counts }),
    );
    const afterRun = screen.getAllByText(/^(First|Second)/).map((node) => node.textContent);
    unmount();

    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() =>
      receive('runs', {
        runs: [first, { ...second, name: 'Second renamed', title: 'Second renamed' }],
        counts,
        otherMatches: 0,
        next: null,
      }),
    );
    const afterRuns = screen.getAllByText(/^(First|Second)/).map((node) => node.textContent);

    expect(afterRun).toEqual(['First', 'Second renamed']);
    expect(afterRun).toEqual(afterRuns);
  });

  it('moves the status stamp when a run the list does not hold changes status', () => {
    const counts = { active: 1, done: 0, all: 1 };
    const outside = { ...runSummary(), key: 'r-9', status: 'running' as const };
    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => receive('runs', { runs: [], counts, otherMatches: 0, next: null }));
    act(() => receive('run', { rows: [outside], removed: [], counts }));
    const before = screen.getByText(/^stamp/).textContent;
    act(() => receive('run', { rows: [outside], removed: [], counts }));
    expect(screen.getByText(/^stamp/).textContent).toBe(before);
    act(() => receive('run', { rows: [{ ...outside, status: 'failed' }], removed: [], counts }));
    expect(screen.getByText(/^stamp/).textContent).not.toBe(before);
  });

  it('keeps the last events message of the watched run and ignores another run', () => {
    render(<Probe />, { wrapper: LiveBridgeProvider });
    act(() => watch('r1'));

    act(() => receive('events', { key: 'r2', step: 'implement', seq: 9 }));
    expect(screen.queryByText(/^events/)).not.toBeInTheDocument();

    act(() => receive('events', { key: 'r1', step: 'implement', seq: 4 }));
    expect(screen.getByText('events 4')).toBeInTheDocument();
  });

  it('moves the stamp of one backlog on a backlog event and on a run row with its label', () => {
    const counts = { active: 1, done: 0, all: 1 };
    const labelled = (name: string) => ({ ...runSummary(), backlog: { name, milestone: 3 } });
    render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('backlogs {}')).toBeInTheDocument();

    act(() => receive('backlog', { backlog: 'shop' }));
    expect(screen.getByText('backlogs {"shop":1}')).toBeInTheDocument();
    expect(screen.getByText('shop stamp 1')).toBeInTheDocument();

    act(() => receive('run', { rows: [labelled('api')], removed: [], counts }));
    expect(screen.getByText('backlogs {"shop":1,"api":1}')).toBeInTheDocument();

    // The same row sent again, as a cost tick does, moves nothing.
    act(() => receive('run', { rows: [labelled('api')], removed: [], counts }));
    expect(screen.getByText('backlogs {"shop":1,"api":1}')).toBeInTheDocument();

    act(() => receive('run', { rows: [{ ...labelled('api'), status: 'done' }], removed: [], counts }));
    expect(screen.getByText('backlogs {"shop":1,"api":2}')).toBeInTheDocument();

    act(() => receive('run', { rows: [runSummary()], removed: [], counts }));
    expect(screen.getByText('backlogs {"shop":1,"api":2}')).toBeInTheDocument();
  });

  it('applies a usage event to the held row and keeps the latest entry per run', () => {
    function Usage() {
      const runs = useLiveBridge((snapshot) => snapshot.runs);
      const usage = useLiveBridge((snapshot) => snapshot.usage);
      return (
        <div>
          {runs.map((run) => (
            <p key={run.key}>usd {run.usd}</p>
          ))}
          <p>tokens {usage['run-1']?.tokens ?? 'none'}</p>
        </div>
      );
    }
    render(<Usage />, { wrapper: LiveBridgeProvider });
    act(() => receive('runs', runsPage([{ ...runSummary(), usd: 1 }], { part: 'active' })));
    expect(screen.getByText('usd 1')).toBeInTheDocument();
    expect(screen.getByText('tokens none')).toBeInTheDocument();

    act(() => receive('usage', { key: 'run-1', tokens: 5, usd: 2, cpuPeak: 0, memPeak: 0 }));
    act(() => receive('usage', { key: 'run-1', tokens: 9, usd: 2.5, cpuPeak: 0, memPeak: 0 }));

    expect(screen.getByText('usd 2.5')).toBeInTheDocument();
    expect(screen.getByText('tokens 9')).toBeInTheDocument();
  });

  it('holds the items of a done event, null before the first one', () => {
    function Done() {
      const done = useLiveBridge((snapshot) => snapshot.done);
      return <p>{done === null ? 'no event' : done.map((item) => item.key).join(',')}</p>;
    }
    render(<Done />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('no event')).toBeInTheDocument();

    act(() => receive('done', [doneItem(runSummary()), doneItem({ ...runSummary(), key: 'run-2' })]));

    expect(screen.getByText('run-1,run-2')).toBeInTheDocument();
  });
});

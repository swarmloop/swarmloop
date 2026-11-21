import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import type { RunsPage } from '@contract/run-list';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRuns, removeRun } from '../../lib/endpoints';
import { receive } from '../../test/fake-socket';
import { runSummary } from '../../test/fixtures';
import { runsPage } from '../../test/runs-page';
import { LiveBridgeProvider, useLiveActions } from '../shell';
import { etaText } from '../../lib/eta-words';
import { useRuns } from './use-runs';

vi.mock('../../lib/endpoints', () => ({ listRuns: vi.fn(), removeRun: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

function Probe() {
  const { runs, error, connected, removeRun } = useRuns();
  return (
    <div>
      <p>{connected ? 'live' : 'offline'}</p>
      {error ? <p>{error}</p> : null}
      {runs.map((run) => (
        <div key={run.key}>
          <p>{run.name}</p>
          <button type="button" onClick={() => void removeRun(run.key)}>
            Remove {run.name}
          </button>
        </div>
      ))}
    </div>
  );
}

describe('useRuns', () => {
  it('shows the runs from GET /runs on mount', async () => {
    vi.mocked(listRuns).mockResolvedValue(runsPage([runSummary()], { part: 'active' }));

    render(<Probe />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('Run one')).toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledWith({ part: 'active', q: '' });
  });

  it('replaces the list with a runs socket event', async () => {
    vi.mocked(listRuns).mockResolvedValue(runsPage([runSummary()], { part: 'active' }));
    render(<Probe />, { wrapper: LiveBridgeProvider });
    await screen.findByText('Run one');

    act(() => receive('runs', runsPage([{ ...runSummary(), key: 'run-2', name: 'Run two' }], { part: 'active' })));

    expect(await screen.findByText('Run two')).toBeInTheDocument();
    expect(screen.queryByText('Run one')).not.toBeInTheDocument();
  });

  it('shows the message of a rejected Error', async () => {
    vi.mocked(listRuns).mockRejectedValue(new Error('boom'));

    render(<Probe />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('lists again on retry, clears the error and is loaded once a list arrived', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(listRuns)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(runsPage([runSummary()], { part: 'active' }));
    function RetryProbe() {
      const { runs, loaded, error, retry } = useRuns();
      return (
        <div>
          <p>{loaded ? 'loaded' : 'not loaded'}</p>
          {error ? <p>{error}</p> : null}
          {runs.map((run) => (
            <p key={run.key}>{run.name}</p>
          ))}
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      );
    }
    render(<RetryProbe />, { wrapper: LiveBridgeProvider });
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByText('not loaded')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Run one')).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    expect(screen.getByText('loaded')).toBeInTheDocument();
  });

  it('says the api is not reachable when the rejection is not an Error', async () => {
    vi.mocked(listRuns).mockRejectedValue('down');

    render(<Probe />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('api is not reachable')).toBeInTheDocument();
  });

  it('shows live on connect and offline on disconnect', async () => {
    vi.mocked(listRuns).mockResolvedValue(runsPage([], { part: 'active' }));
    render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('offline')).toBeInTheDocument();

    act(() => receive('connect'));
    expect(screen.getByText('live')).toBeInTheDocument();

    act(() => receive('disconnect'));
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('sends DELETE for a removed run and drops its row', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(listRuns).mockResolvedValue(runsPage([runSummary()], { part: 'active' }));
    vi.mocked(removeRun).mockResolvedValue({ key: 'run-1' });
    render(<Probe />, { wrapper: LiveBridgeProvider });
    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));

    await waitFor(() => expect(screen.queryByText('Run one')).not.toBeInTheDocument());
    expect(removeRun).toHaveBeenCalledWith('run-1');
  });

  it('keeps a run that arrives while the DELETE is pending', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (() => void) | undefined;
    vi.mocked(listRuns).mockResolvedValue(runsPage([runSummary()], { part: 'active' }));
    vi.mocked(removeRun).mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ key: 'run-1' });
      }),
    );
    render(<Probe />, { wrapper: LiveBridgeProvider });
    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));

    act(() =>
      receive('runs', runsPage([runSummary(), { ...runSummary(), key: 'run-2', name: 'Run two' }], { part: 'active' })),
    );
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText('Run one')).not.toBeInTheDocument());
    expect(screen.getByText('Run two')).toBeInTheDocument();
  });
});

describe('useRuns pages', () => {
  const merged = (key: string) => ({ ...runSummary(), key, name: key, title: key, state: 'merged' as const });
  const counts = { active: 0, done: 2, all: 2 };

  function PagesProbe({ part = 'done', q = '' }: { part?: 'active' | 'done'; q?: string }) {
    const { runs, next, loadingMore, loadMore, listing } = useRuns();
    const { showList } = useLiveActions();
    useEffect(() => showList(part, q), [showList, part, q]);
    return (
      <div>
        <p>{listing ? 'listing' : 'listed'}</p>
        <p>{loadingMore ? 'loading more' : 'idle'}</p>
        <p>{next === null ? 'last page' : `next ${next}`}</p>
        {runs.map((run) => (
          <p key={run.key}>{run.name}</p>
        ))}
        <button type="button" onClick={loadMore}>
          More
        </button>
      </div>
    );
  }

  it('loads the first page of the chosen view, and the next page appended with one request at a time', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: ((value: RunsPage) => void) | undefined;
    vi.mocked(listRuns).mockImplementation(({ cursor }) =>
      cursor === undefined
        ? Promise.resolve({ runs: [merged('m-1')], counts, otherMatches: 0, next: 'c1' })
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    render(<PagesProbe />, { wrapper: LiveBridgeProvider });
    expect(await screen.findByText('next c1')).toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledWith({ part: 'done', q: '' });

    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('loading more')).toBeInTheDocument();
    await act(async () => finish?.({ runs: [merged('m-2')], counts, otherMatches: 0, next: null }));

    expect(await screen.findByText('last page')).toBeInTheDocument();
    expect(screen.getByText('m-1')).toBeInTheDocument();
    expect(screen.getByText('m-2')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    expect(vi.mocked(listRuns).mock.calls.filter(([query]) => query.cursor === 'c1')).toHaveLength(1);
  });

  it('lists again when the counts change while a filter finds nothing', async () => {
    vi.mocked(listRuns).mockResolvedValue({ runs: [], counts, otherMatches: 1, next: null });
    render(<PagesProbe part="active" q="zzz" />, { wrapper: LiveBridgeProvider });
    await screen.findByText('listed');
    const before = vi.mocked(listRuns).mock.calls.length;

    act(() => receive('run', { rows: [], removed: [], counts: { active: 0, done: 3, all: 3 } }));

    await waitFor(() => expect(vi.mocked(listRuns).mock.calls.length).toBeGreaterThan(before));
  });
});

describe('useRuns clock', () => {
  function NowProbe() {
    const { now } = useRuns();
    return <p data-testid="now">{now}</p>;
  }
  const shown = () => Number(screen.getByTestId('now').textContent);

  async function renderAt(status: string): Promise<void> {
    vi.useFakeTimers();
    vi.mocked(listRuns).mockResolvedValue(runsPage([{ ...runSummary(), status }], { part: 'active' }));
    render(<NowProbe />, { wrapper: LiveBridgeProvider });
    await act(async () => {});
  }

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('moves the time on every second while a run works', async () => {
    await renderAt('running');
    const start = shown();

    act(() => vi.advanceTimersByTime(1000));

    expect(shown() - start).toBe(1000);
  });

  it('keeps moving the time on when no run works, so relative times and day headers do not freeze', async () => {
    await renderAt('waiting');
    const start = shown();

    act(() => vi.advanceTimersByTime(2 * 60_000));

    expect(shown() - start).toBeGreaterThanOrEqual(60_000);
  });

  it('counts an estimate down as the clock moves, with no new request', async () => {
    vi.useFakeTimers();
    const doneAt = new Date(Date.now() + 25 * 60_000).toISOString();
    vi.mocked(listRuns).mockClear();
    vi.mocked(listRuns).mockResolvedValue(
      runsPage([{ ...runSummary(), status: 'running', eta: { leftMs: 25 * 60_000, doneAt } }], { part: 'active' }),
    );
    function EtaProbe() {
      const { runs, now } = useRuns();
      return <p data-testid="eta">{runs[0]?.eta ? etaText(runs[0].eta, now).text : ''}</p>;
    }
    render(<EtaProbe />, { wrapper: LiveBridgeProvider });
    await act(async () => {});
    expect(screen.getByTestId('eta')).toHaveTextContent('~25m left');
    const requests = vi.mocked(listRuns).mock.calls.length;

    act(() => vi.advanceTimersByTime(10 * 60_000));

    expect(screen.getByTestId('eta')).toHaveTextContent('~15m left');
    expect(vi.mocked(listRuns).mock.calls.length).toBe(requests);
  });
});

describe('useRuns on a reconnect', () => {
  const finished = { ...runSummary(), key: 'run-9', name: 'Run nine', title: 'Run nine', state: 'merged' as const };

  function ShownProbe() {
    const { runs } = useRuns();
    const { showList } = useLiveActions();
    useEffect(() => showList('done', 'nine'), [showList]);
    return (
      <div>
        {runs.map((run) => (
          <p key={run.key}>{run.name}</p>
        ))}
      </div>
    );
  }

  async function shown(): Promise<void> {
    vi.mocked(listRuns).mockReset();
    vi.mocked(listRuns).mockResolvedValue(runsPage([], { part: 'done' }));
    render(<ShownProbe />, { wrapper: LiveBridgeProvider });
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ part: 'done', q: 'nine' }));
    act(() => receive('connect'));
    vi.mocked(listRuns).mockClear();
  }

  it('reads the shown part and filter again and shows the answer', async () => {
    await shown();
    vi.mocked(listRuns).mockResolvedValue(runsPage([finished], { part: 'done' }));

    act(() => receive('disconnect'));
    act(() => receive('connect'));

    expect(await screen.findByText('Run nine')).toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledWith({ part: 'done', q: 'nine' });
  });

  it('reads again when the disconnect and the connect fall in one render batch', async () => {
    await shown();

    act(() => {
      receive('disconnect');
      receive('connect');
    });

    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ part: 'done', q: 'nine' }));
  });

  it('does not read again on the first connect', async () => {
    vi.mocked(listRuns).mockReset();
    vi.mocked(listRuns).mockResolvedValue(runsPage([], { part: 'done' }));
    render(<ShownProbe />, { wrapper: LiveBridgeProvider });
    await waitFor(() => expect(listRuns).toHaveBeenCalled());
    vi.mocked(listRuns).mockClear();

    act(() => receive('connect'));
    await act(async () => {});

    expect(listRuns).not.toHaveBeenCalled();
  });
});

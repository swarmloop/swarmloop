import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { listRuns, removeRun } from '../lib/endpoints';
import { receive } from '../test/fake-socket';
import { runSummary } from '../test/fixtures';
import { LiveBridgeProvider } from './use-live-bridge';
import { useRuns } from './use-runs';

vi.mock('../lib/endpoints', () => ({ listRuns: vi.fn(), removeRun: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

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
    vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });

    render(<Probe />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('Run one')).toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledWith();
  });

  it('replaces the list with a runs socket event', async () => {
    vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });
    render(<Probe />, { wrapper: LiveBridgeProvider });
    await screen.findByText('Run one');

    act(() => receive('runs', { runs: [{ ...runSummary(), key: 'run-2', name: 'Run two' }] }));

    expect(await screen.findByText('Run two')).toBeInTheDocument();
    expect(screen.queryByText('Run one')).not.toBeInTheDocument();
  });

  it('shows the message of a rejected Error', async () => {
    vi.mocked(listRuns).mockRejectedValue(new Error('boom'));

    render(<Probe />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('says the api is not reachable when the rejection is not an Error', async () => {
    vi.mocked(listRuns).mockRejectedValue('down');

    render(<Probe />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText('api is not reachable')).toBeInTheDocument();
  });

  it('shows live on connect and offline on disconnect', async () => {
    vi.mocked(listRuns).mockResolvedValue({ runs: [] });
    render(<Probe />, { wrapper: LiveBridgeProvider });
    expect(screen.getByText('offline')).toBeInTheDocument();

    act(() => receive('connect'));
    expect(screen.getByText('live')).toBeInTheDocument();

    act(() => receive('disconnect'));
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('sends DELETE for a removed run and drops its row', async () => {
    const user = userEvent.setup();
    vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });
    vi.mocked(removeRun).mockResolvedValue({ key: 'run-1' });
    render(<Probe />, { wrapper: LiveBridgeProvider });
    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));

    await waitFor(() => expect(screen.queryByText('Run one')).not.toBeInTheDocument());
    expect(removeRun).toHaveBeenCalledWith('run-1');
  });

  it('keeps a run that arrives while the DELETE is pending', async () => {
    const user = userEvent.setup();
    let finish: (() => void) | undefined;
    vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });
    vi.mocked(removeRun).mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ key: 'run-1' });
      }),
    );
    render(<Probe />, { wrapper: LiveBridgeProvider });
    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));

    act(() => receive('runs', { runs: [runSummary(), { ...runSummary(), key: 'run-2', name: 'Run two' }] }));
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText('Run one')).not.toBeInTheDocument());
    expect(screen.getByText('Run two')).toBeInTheDocument();
  });

});

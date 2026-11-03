import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { receive } from '../test/fake-socket';
import { runSummary } from '../test/fixtures';
import { useLive } from './use-live';

vi.mock('../lib/api', () => ({ api: vi.fn(), runLog: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

function Probe() {
  const { runs, error, connected, removeRun } = useLive();
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

describe('useLive', () => {
  it('shows the runs from GET /runs on mount', async () => {
    vi.mocked(api).mockResolvedValue({ runs: [runSummary()] });

    render(<Probe />);

    expect(await screen.findByText('Run one')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/runs');
  });

  it('replaces the list with a runs socket event', async () => {
    vi.mocked(api).mockResolvedValue({ runs: [runSummary()] });
    render(<Probe />);
    await screen.findByText('Run one');

    act(() => receive('runs', { runs: [{ ...runSummary(), key: 'run-2', name: 'Run two' }] }));

    expect(await screen.findByText('Run two')).toBeInTheDocument();
    expect(screen.queryByText('Run one')).not.toBeInTheDocument();
  });

  it('shows the message of a rejected Error', async () => {
    vi.mocked(api).mockRejectedValue(new Error('boom'));

    render(<Probe />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('says the api is not reachable when the rejection is not an Error', async () => {
    vi.mocked(api).mockRejectedValue('down');

    render(<Probe />);

    expect(await screen.findByText('api is not reachable')).toBeInTheDocument();
  });

  it('shows live on connect and offline on disconnect', async () => {
    vi.mocked(api).mockResolvedValue({ runs: [] });
    render(<Probe />);
    expect(screen.getByText('offline')).toBeInTheDocument();

    act(() => receive('connect'));
    expect(screen.getByText('live')).toBeInTheDocument();

    act(() => receive('disconnect'));
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('sends DELETE for a removed run and drops its row', async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { key: 'run-1' };
      }
      return { runs: [runSummary()] };
    });
    render(<Probe />);
    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));

    await waitFor(() => expect(screen.queryByText('Run one')).not.toBeInTheDocument());
    expect(api).toHaveBeenCalledWith('/runs/run-1', { method: 'DELETE' });
  });
});

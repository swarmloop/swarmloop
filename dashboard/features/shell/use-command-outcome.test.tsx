import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandView } from '@contract/command';
import { getCommand } from '../../lib/endpoints';
import { receive, resetFakeSocket } from '../../test/fake-socket';
import { useCommandOutcome } from './use-command-outcome';
import { LiveBridgeProvider } from './use-live-bridge';

vi.mock('../../lib/endpoints', () => ({ getCommand: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

const view = (state: CommandView['state']): CommandView => ({
  commandId: 'c1',
  type: 'create-repository',
  state,
  value: { name: 'demo' },
  error: null,
});

function Probe({ id }: { id: string | null }) {
  const outcome = useCommandOutcome(id);
  return <p>{outcome === null ? 'waiting' : `${outcome.state} ${JSON.stringify(outcome.value)}`}</p>;
}

beforeEach(() => {
  resetFakeSocket();
  vi.mocked(getCommand).mockReset();
});

describe('useCommandOutcome', () => {
  it('reads nothing without an id', () => {
    render(<Probe id={null} />, { wrapper: LiveBridgeProvider });

    expect(screen.getByText('waiting')).toBeInTheDocument();
    expect(getCommand).not.toHaveBeenCalled();
  });

  it('gives null while the command runs and its view once it has ended, read again on a command event', async () => {
    vi.mocked(getCommand).mockResolvedValue(view('executing'));
    render(<Probe id="c1" />, { wrapper: LiveBridgeProvider });
    await waitFor(() => expect(getCommand).toHaveBeenCalledWith('c1'));
    expect(screen.getByText('waiting')).toBeInTheDocument();

    vi.mocked(getCommand).mockResolvedValue(view('succeeded'));
    act(() => receive('command', { commandId: 'c1', state: 'succeeded' }));

    expect(await screen.findByText('succeeded {"name":"demo"}')).toBeInTheDocument();
  });

  it('reads again after a reconnect', async () => {
    vi.mocked(getCommand).mockResolvedValue(view('executing'));
    render(<Probe id="c1" />, { wrapper: LiveBridgeProvider });
    act(() => receive('connect'));
    await waitFor(() => expect(getCommand).toHaveBeenCalledTimes(1));

    vi.mocked(getCommand).mockResolvedValue(view('failed'));
    act(() => receive('connect'));

    expect(await screen.findByText(/^failed/)).toBeInTheDocument();
  });

  it('retries a failed read on the next event', async () => {
    vi.mocked(getCommand).mockRejectedValue(new Error('offline'));
    render(<Probe id="c1" />, { wrapper: LiveBridgeProvider });
    await waitFor(() => expect(getCommand).toHaveBeenCalledTimes(1));

    vi.mocked(getCommand).mockResolvedValue(view('succeeded'));
    act(() => receive('command', { commandId: 'c1', state: 'succeeded' }));

    expect(await screen.findByText(/^succeeded/)).toBeInTheDocument();
  });
});

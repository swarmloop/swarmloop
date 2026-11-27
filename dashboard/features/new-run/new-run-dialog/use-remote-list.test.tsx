import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteListView } from '@contract/api';
import { listRemote, refreshRemote } from '../../../lib/endpoints';
import { receive, resetFakeSocket } from '../../../test/fake-socket';
import { LiveBridgeProvider } from '../../shell';
import { useRemoteList } from './use-remote-list';

vi.mock('../../../lib/endpoints', () => ({ listRemote: vi.fn(), refreshRemote: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

const view = (extra: Partial<RemoteListView> = {}): RemoteListView => ({
  repositories: [],
  owners: [],
  reason: null,
  allowedNames: [],
  loading: false,
  error: null,
  ...extra,
});

function Probe() {
  const { remote, error, reload, retry } = useRemoteList(true);
  return (
    <div>
      <p>{remote === null ? 'no list' : remote.loading ? 'loading' : `list ${remote.reason ?? 'ready'}`}</p>
      <p>{error === null ? 'no error' : `error ${error}`}</p>
      <button onClick={reload}>reload</button>
      <button onClick={retry}>retry</button>
    </div>
  );
}

const show = () => render(<Probe />, { wrapper: LiveBridgeProvider });

beforeEach(() => {
  resetFakeSocket();
  vi.mocked(listRemote).mockReset();
  vi.mocked(refreshRemote).mockReset();
});

describe('useRemoteList', () => {
  it('reads the list when it opens, and a failed read gives its error and keeps the last list', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'first' }));
    show();
    expect(await screen.findByText('list first')).toBeInTheDocument();

    vi.mocked(listRemote).mockRejectedValueOnce(new Error('GitHub is down'));
    await user.click(screen.getByRole('button', { name: 'reload' }));

    expect(await screen.findByText('error GitHub is down')).toBeInTheDocument();
    expect(screen.getByText('list first')).toBeInTheDocument();
  });

  it('reads again on every command event, also when the list is not loading', async () => {
    vi.mocked(listRemote).mockResolvedValueOnce(view({ loading: true }));
    show();
    expect(await screen.findByText('loading')).toBeInTheDocument();

    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'done' }));
    act(() => receive('command', { commandId: 'c1', state: 'succeeded' }));
    expect(await screen.findByText('list done')).toBeInTheDocument();

    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'with the new repository' }));
    act(() => receive('command', { commandId: 'c2', state: 'succeeded' }));
    expect(await screen.findByText('list with the new repository')).toBeInTheDocument();
    expect(listRemote).toHaveBeenCalledTimes(3);
  });

  it('reads again when a command ended during a read, and drops that read when it answers loading', async () => {
    let answer: (v: RemoteListView) => void = () => undefined;
    vi.mocked(listRemote).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    show();
    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'done' }));
    act(() => receive('command', { commandId: 'c1', state: 'succeeded' }));

    expect(await screen.findByText('list done')).toBeInTheDocument();
    await act(async () => answer(view({ loading: true })));

    expect(screen.getByText('list done')).toBeInTheDocument();
    expect(listRemote).toHaveBeenCalledTimes(2);
  });

  it('does not read again when a read answers loading and no command ended during it', async () => {
    vi.mocked(listRemote).mockResolvedValueOnce(view({ loading: true }));
    show();
    expect(await screen.findByText('loading')).toBeInTheDocument();
    expect(listRemote).toHaveBeenCalledTimes(1);
  });

  it('drops the answer of an older read', async () => {
    const user = userEvent.setup({ delay: null });
    let older: (v: RemoteListView) => void = () => undefined;
    vi.mocked(listRemote).mockReturnValueOnce(new Promise((resolve) => (older = resolve)));
    show();
    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'newer' }));
    await user.click(screen.getByRole('button', { name: 'reload' }));
    await screen.findByText('list newer');

    await act(async () => older(view({ reason: 'older' })));

    expect(screen.getByText('list newer')).toBeInTheDocument();
  });

  it('reads again after a reconnect', async () => {
    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'first' }));
    show();
    act(() => receive('connect'));
    await screen.findByText('list first');

    vi.mocked(listRemote).mockResolvedValueOnce(view({ reason: 'second' }));
    act(() => receive('connect'));

    expect(await screen.findByText('list second')).toBeInTheDocument();
  });

  it('retry clears the error and refreshes through refreshRemote', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(listRemote).mockRejectedValueOnce(new Error('GitHub is down'));
    show();
    await screen.findByText('error GitHub is down');

    vi.mocked(refreshRemote).mockResolvedValue(view({ loading: true }));
    await user.click(screen.getByRole('button', { name: 'retry' }));

    expect(await screen.findByText('loading')).toBeInTheDocument();
    expect(screen.getByText('no error')).toBeInTheDocument();
  });
});

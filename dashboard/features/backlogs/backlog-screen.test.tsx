import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBacklog, getBacklogChat, getRepositoryMain, listBacklogs } from '../../lib/backlog-endpoints';
import { getSession } from '../../lib/endpoints';
import { backlogChatView, backlogView } from '../../test/backlog-fixtures';
import { receive } from '../../test/fake-socket';
import { QueryWrapper } from '../../test/query-wrapper';
import { mediaWidth } from '../../test/viewport';
import { LiveBridgeProvider } from '../shell';
import { BacklogScreen } from './backlog-screen';
import { BacklogsHome } from './backlogs-home';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock('../../lib/backlog-endpoints', () => ({
  getBacklog: vi.fn(),
  getBacklogChat: vi.fn(),
  listBacklogs: vi.fn(),
  createBacklog: vi.fn(),
  getRepositoryMain: vi.fn(),
}));
vi.mock('../../lib/endpoints', () => ({
  getSession: vi.fn(),
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  refreshRemote: vi.fn(),
  getCommand: vi.fn(),
  createRepository: vi.fn(),
}));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());
vi.mock('../shell', async () => {
  const bridge = await import('../shell/use-live-bridge');
  const { useOnReconnect } = await import('../shell/use-on-reconnect');
  const { useCommandOutcome } = await import('../shell/use-command-outcome');
  const { ConfirmDialog } = await import('../shell/confirm-dialog');
  return {
    ConfirmDialog,
    useOnReconnect,
    useCommandOutcome,
    useCommandEnds: bridge.useCommandEnds,
    LiveBridgeProvider: bridge.LiveBridgeProvider,
    useLiveBridge: bridge.useLiveBridge,
    useBacklogStamp: bridge.useBacklogStamp,
  };
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

beforeEach(() => {
  replace.mockReset();
  vi.mocked(getBacklog).mockResolvedValue(backlogView());
  vi.mocked(getRepositoryMain).mockRejectedValue(new Error('offline'));
  vi.mocked(getBacklogChat).mockResolvedValue(backlogChatView());
  vi.mocked(getSession).mockResolvedValue({ user: 'ada' });
});

describe('BacklogScreen on a desktop', () => {
  mediaWidth(1280);

  it('shows the chat and the right column side by side under the header', async () => {
    render(<BacklogScreen name="swarmloop" />, { wrapper: Wrapper });

    expect(await screen.findByRole('heading', { name: 'swarmloop' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Milestone' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('BacklogScreen on a phone', () => {
  mediaWidth(375);

  it('shows the tabs Chat, Milestone and Backlog and switches between them', async () => {
    render(<BacklogScreen name="swarmloop" />, { wrapper: Wrapper });

    expect(await screen.findAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('region', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Milestone' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Milestone' }));
    expect(screen.getByRole('region', { name: 'Milestone' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Chat' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Backlog' }));
    expect(screen.getByRole('region', { name: 'Backlog' })).toBeInTheDocument();
  });
});

describe('BacklogScreen at 800 px', () => {
  mediaWidth(800);

  it('shows the three tabs with the chat open', async () => {
    render(<BacklogScreen name="swarmloop" />, { wrapper: Wrapper });

    expect(await screen.findAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Milestone' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Milestone' })).not.toBeInTheDocument();
  });
});

describe('BacklogsHome', () => {
  it('replaces the URL with the first backlog', async () => {
    vi.mocked(listBacklogs).mockResolvedValue([backlogView(), backlogView({ name: 'shop' })]);
    render(<BacklogsHome />, { wrapper: Wrapper });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/backlogs/swarmloop'));
  });

  it('shows an empty state with + New backlog when there is none', async () => {
    vi.mocked(listBacklogs).mockResolvedValue([]);
    render(<BacklogsHome />, { wrapper: Wrapper });

    expect(await screen.findByRole('button', { name: '+ New backlog' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('BacklogScreen after a reconnect', () => {
  mediaWidth(1280);

  it('reads the backlog and its chat again, and nothing extra on the first connect', async () => {
    render(<BacklogScreen name="swarmloop" />, { wrapper: Wrapper });
    await screen.findByRole('heading', { name: 'swarmloop' });

    act(() => receive('connect'));
    await act(async () => {});
    expect(getBacklog).toHaveBeenCalledTimes(1);

    act(() => receive('disconnect'));
    act(() => receive('connect'));

    await vi.waitFor(() => expect(getBacklog).toHaveBeenCalledTimes(2));
    expect(getBacklogChat).toHaveBeenCalledTimes(2);
  });
});

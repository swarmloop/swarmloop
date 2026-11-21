import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBacklog, getBacklogChat, getRepositoryMain, listBacklogs } from '../../lib/backlog-endpoints';
import { getSession } from '../../lib/endpoints';
import { backlogChatView, backlogView } from '../../test/backlog-fixtures';
import { QueryWrapper } from '../../test/query-wrapper';
import { mediaWidth } from '../../test/viewport';
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
vi.mock('../../lib/endpoints', () => ({ getSession: vi.fn(), listProjects: vi.fn(), listRemote: vi.fn() }));
vi.mock('../shell', () => ({ useLiveBridge: () => 0, useBacklogStamp: () => 0 }));

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
    render(<BacklogScreen name="swarmloop" />, { wrapper: QueryWrapper });

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
    render(<BacklogScreen name="swarmloop" />, { wrapper: QueryWrapper });

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

describe('BacklogsHome', () => {
  it('replaces the URL with the first backlog', async () => {
    vi.mocked(listBacklogs).mockResolvedValue([backlogView(), backlogView({ name: 'shop' })]);
    render(<BacklogsHome />, { wrapper: QueryWrapper });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/backlogs/swarmloop'));
  });

  it('shows an empty state with + New backlog when there is none', async () => {
    vi.mocked(listBacklogs).mockResolvedValue([]);
    render(<BacklogsHome />, { wrapper: QueryWrapper });

    expect(await screen.findByRole('button', { name: '+ New backlog' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

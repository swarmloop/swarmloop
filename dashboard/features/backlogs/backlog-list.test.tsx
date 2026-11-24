import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { backlogView } from '../../test/backlog-fixtures';
import { receive } from '../../test/fake-socket';
import { QueryWrapper } from '../../test/query-wrapper';
import { LiveBridgeProvider } from '../shell';
import { BacklogList } from './backlog-list';

vi.mock('../../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn(), createBacklog: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({ listProjects: vi.fn(), listRemote: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());
vi.mock('../shell', async () => {
  const bridge = await import('../shell/use-live-bridge');
  return { LiveBridgeProvider: bridge.LiveBridgeProvider, useLiveBridge: bridge.useLiveBridge };
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

beforeEach(() => {
  vi.mocked(listBacklogs).mockResolvedValue([backlogView(), backlogView({ name: 'shop', milestones: [] })]);
});

describe('BacklogList', () => {
  it('shows each backlog with its progress, marks the selected one and ends with + New backlog', async () => {
    render(<BacklogList selected="swarmloop" />, { wrapper: Wrapper });

    const first = await screen.findByRole('link', { name: /swarmloop/ });
    expect(first).toHaveTextContent('M3 · 4/7');
    expect(first).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'shop' })).not.toHaveAttribute('aria-current');
    const last = screen.getAllByRole('button').at(-1);
    expect(last).toHaveTextContent('+ New backlog');
  });

  it('goes to a backlog on click and tells the shell', async () => {
    const picked = vi.fn();
    render(<BacklogList selected="swarmloop" onPick={picked} />, { wrapper: Wrapper });

    const link = await screen.findByRole('link', { name: 'shop' });
    expect(link).toHaveAttribute('href', '/backlogs/shop');
    await userEvent.click(link);
    expect(picked).toHaveBeenCalled();
  });

  it('reads the backlogs again after a reconnect, and nothing extra on the first connect', async () => {
    render(<BacklogList selected="swarmloop" />, { wrapper: Wrapper });
    await screen.findByRole('link', { name: 'shop' });

    act(() => receive('connect'));
    await act(async () => {});
    expect(listBacklogs).toHaveBeenCalledTimes(1);

    vi.mocked(listBacklogs).mockResolvedValue([backlogView({ name: 'blog', milestones: [] })]);
    act(() => receive('disconnect'));
    act(() => receive('connect'));

    expect(await screen.findByRole('link', { name: 'blog' })).toBeInTheDocument();
    expect(listBacklogs).toHaveBeenCalledTimes(2);
  });
});

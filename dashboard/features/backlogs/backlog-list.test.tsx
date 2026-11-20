import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { backlogView } from '../../test/backlog-fixtures';
import { QueryWrapper } from '../../test/query-wrapper';
import { BacklogList } from './backlog-list';

vi.mock('../../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn(), createBacklog: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({ listProjects: vi.fn(), listRemote: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../shell', () => ({ useLiveBridge: () => 0 }));

beforeEach(() => {
  vi.mocked(listBacklogs).mockResolvedValue([backlogView(), backlogView({ name: 'shop', milestones: [] })]);
});

describe('BacklogList', () => {
  it('shows each backlog with its progress, marks the selected one and ends with + New backlog', async () => {
    render(<BacklogList selected="swarmloop" />, { wrapper: QueryWrapper });

    const first = await screen.findByRole('link', { name: /swarmloop/ });
    expect(first).toHaveTextContent('M3 · 4/7');
    expect(first).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'shop' })).not.toHaveAttribute('aria-current');
    const last = screen.getAllByRole('button').at(-1);
    expect(last).toHaveTextContent('+ New backlog');
  });

  it('goes to a backlog on click and tells the shell', async () => {
    const picked = vi.fn();
    render(<BacklogList selected="swarmloop" onPick={picked} />, { wrapper: QueryWrapper });

    const link = await screen.findByRole('link', { name: 'shop' });
    expect(link).toHaveAttribute('href', '/backlogs/shop');
    await userEvent.click(link);
    expect(picked).toHaveBeenCalled();
  });
});

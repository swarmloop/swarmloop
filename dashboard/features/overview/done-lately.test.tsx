import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { getFlow, listRuns } from '../../lib/endpoints';
import { acceptedMilestoneBacklog } from '../../test/backlog-fixtures';
import { mergedAt, mergedRun, returnsFlow } from '../../test/overview-fixtures';
import { listRunsFrom } from '../../test/runs-page';
import { DoneLately } from './index';
import { PartsWrapper } from './test-wrapper.spec-helpers';

vi.mock('../../lib/endpoints', () => ({ listRuns: vi.fn(), getFlow: vi.fn() }));
vi.mock('../../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listBacklogs).mockResolvedValue([]);
  vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, key === 'run-1' ? [1, 1] : [])));
});

describe('DoneLately', () => {
  it('shows five lines of seven done runs, each opening its run with the merge request as one more link', async () => {
    vi.mocked(listRuns).mockImplementation(
      listRunsFrom(Array.from({ length: 7 }, (_, index) => mergedRun(`run-${index + 1}`))),
    );
    render(<DoneLately />, { wrapper: PartsWrapper });
    expect(await screen.findByText('2 returns, all fixed')).toBeInTheDocument();
    const lines = screen.getAllByRole('listitem');
    expect(lines).toHaveLength(5);
    expect(screen.getAllByText('first pass')).toHaveLength(4);
    const first = lines[0];
    expect(within(first).getByText('Title of run-1').closest('a')).toHaveAttribute('href', '/runs/run-1');
    expect(within(first).getByText('12h 04m')).toBeInTheDocument();
    expect(within(first).getByText('$1.50')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Merge request' })).toHaveAttribute(
      'href',
      'https://example.test/run-1/pull/1',
    );
  });

  it('renders nothing when there is no done run', async () => {
    vi.mocked(listRuns).mockImplementation(listRunsFrom([]));
    const { container } = render(<DoneLately />, { wrapper: PartsWrapper });
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('picks by finish time, not creation order, and not by later unrelated activity', async () => {
    vi.mocked(listRuns).mockImplementation(
      listRunsFrom([
        mergedAt('new-created', '2026-01-02T00:00:00.000Z', { createdAt: '2026-01-05T00:00:00.000Z' }),
        mergedAt('old-created', '2026-01-04T00:00:00.000Z', {
          createdAt: '2025-12-01T00:00:00.000Z',
          updatedAt: '2025-12-02T00:00:00.000Z',
        }),
      ]),
    );
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of old-created');
    const titles = screen.getAllByRole('listitem').map((line) => line.textContent);
    expect(titles[0]).toContain('Title of old-created');
    expect(titles[1]).toContain('Title of new-created');
  });

  it('finds a run finished lately beyond the first page of the list', async () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, index) => mergedAt(`early-${index}`, '2026-01-01T00:00:00.000Z')),
      mergedAt('late-1', '2026-02-01T00:00:00.000Z', { createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    vi.mocked(listRuns).mockImplementation(listRunsFrom(rows));
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of late-1');
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Title of late-1');
  });

  it('finds a run finished last that was created first, past the fifth page', async () => {
    const rows = [
      ...Array.from({ length: 110 }, (_, index) => mergedAt(`early-${index}`, '2026-01-01T00:00:00.000Z')),
      mergedAt('first-made', '2026-03-01T00:00:00.000Z', { createdAt: '2024-01-01T00:00:00.000Z' }),
    ];
    vi.mocked(listRuns).mockImplementation(listRunsFrom(rows));
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of first-made');
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Title of first-made');
  });

  it('shows an accepted milestone once, with its cost, returns and elapsed time, and not its task runs', async () => {
    vi.mocked(listRuns).mockImplementation(
      listRunsFrom([
        mergedAt('task-a', '2026-03-01T10:00:00.000Z', {
          createdAt: '2026-03-01T08:00:00.000Z',
          usd: 2,
          backlog: { name: 'shop', milestone: 3 },
        }),
        mergedAt('task-b', '2026-03-01T12:00:00.000Z', {
          createdAt: '2026-03-01T09:00:00.000Z',
          usd: 3,
          backlog: { name: 'shop', milestone: 3 },
        }),
      ]),
    );
    vi.mocked(listBacklogs).mockResolvedValue([acceptedMilestoneBacklog('shop', ['task-a', 'task-b', 'task-b'])]);
    vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, key === 'task-a' ? [1] : [2])));
    render(<DoneLately />, { wrapper: PartsWrapper });
    const line = (await screen.findByText('Checkout')).closest('li') as HTMLElement;
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(within(line).getByText('4h 00m')).toBeInTheDocument();
    expect(within(line).getByText('$5.00')).toBeInTheDocument();
    expect(await within(line).findByText('3 returns, all fixed')).toBeInTheDocument();
    expect(within(line).getByText('Checkout').closest('a')).toHaveAttribute('href', '/backlogs/shop');
    expect(screen.queryByText('Title of task-a')).not.toBeInTheDocument();
  });

  it('shows placeholders before the lists arrive and a line when they fail', async () => {
    vi.mocked(listRuns).mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<DoneLately />, { wrapper: PartsWrapper });
    expect(screen.getAllByTestId('done-placeholder')).not.toHaveLength(0);
    unmount();
    vi.mocked(listRuns).mockRejectedValue(new Error('down'));
    render(<DoneLately />, { wrapper: PartsWrapper });
    expect(await screen.findByText('Could not load what got done.')).toBeInTheDocument();
  });
});

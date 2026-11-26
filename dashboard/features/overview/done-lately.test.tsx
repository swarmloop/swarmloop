import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDoneLately, getFlow, listRuns } from '../../lib/endpoints';
import { fakeSocket, receive, resetFakeSocket } from '../../test/fake-socket';
import { doneItem, mergedRun, returnsFlow } from '../../test/overview-fixtures';
import { DoneLately } from './index';
import { PartsWrapper } from './test-wrapper.spec-helpers';

vi.mock('../../lib/endpoints', () => ({ getDoneLately: vi.fn(), getFlow: vi.fn(), listRuns: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

beforeEach(() => {
  vi.resetAllMocks();
  resetFakeSocket();
  vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, key === 'run-1' ? [1, 1] : [])));
});

describe('DoneLately', () => {
  it('shows five lines of seven done runs, each opening its run with the merge request as one more link', async () => {
    vi.mocked(getDoneLately).mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => doneItem(mergedRun(`run-${index + 1}`))),
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
    vi.mocked(getDoneLately).mockResolvedValue([]);
    const { container } = render(<DoneLately />, { wrapper: PartsWrapper });
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an accepted milestone as one line that opens its backlog, with the returns of its tasks', async () => {
    const task = mergedRun('task-b', { usd: 5, durationMs: 4 * 3_600_000 });
    vi.mocked(getDoneLately).mockResolvedValue([
      doneItem(task, {
        key: 'shop/3',
        title: 'Checkout',
        link: { backlog: 'shop' },
        runKeys: ['task-a', 'task-b'],
        milestone: true,
      }),
    ]);
    vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, key === 'task-a' ? [1] : [2])));
    render(<DoneLately />, { wrapper: PartsWrapper });
    const line = (await screen.findByText('Checkout')).closest('li') as HTMLElement;
    expect(within(line).getByText('4h 00m')).toBeInTheDocument();
    expect(within(line).getByText('$5.00')).toBeInTheDocument();
    expect(await within(line).findByText('3 returns, all fixed')).toBeInTheDocument();
    expect(within(line).getByText('Checkout').closest('a')).toHaveAttribute('href', '/backlogs/shop');
    expect(within(line).queryByRole('link', { name: 'Merge request' })).not.toBeInTheDocument();
  });

  it('shows placeholders before the lists arrive and a line when they fail', async () => {
    vi.mocked(getDoneLately).mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<DoneLately />, { wrapper: PartsWrapper });
    expect(screen.getAllByTestId('done-placeholder')).not.toHaveLength(0);
    unmount();
    vi.mocked(getDoneLately).mockRejectedValue(new Error('down'));
    render(<DoneLately />, { wrapper: PartsWrapper });
    expect(await screen.findByText('Could not load what got done.')).toBeInTheDocument();
  });

  it('reads once when it opens and never asks the run list', async () => {
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-1'))]);
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of run-1');
    expect(getDoneLately).toHaveBeenCalledTimes(1);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('shows the lines of a done event with no read', async () => {
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-1'))]);
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of run-1');

    act(() => receive('done', [doneItem(mergedRun('run-2')), doneItem(mergedRun('run-1'))]));

    expect(await screen.findByText('Title of run-2')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Title of run-2');
    expect(getDoneLately).toHaveBeenCalledTimes(1);
  });

  it('does not let a read that was on its way overwrite the lines of a done event', async () => {
    let answer: (items: Awaited<ReturnType<typeof getDoneLately>>) => void = () => undefined;
    vi.mocked(getDoneLately).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<DoneLately />, { wrapper: PartsWrapper });

    act(() => receive('done', [doneItem(mergedRun('run-2'))]));
    await screen.findByText('Title of run-2');
    await act(async () => answer([doneItem(mergedRun('run-1'))]));

    expect(screen.getByText('Title of run-2')).toBeInTheDocument();
    expect(screen.queryByText('Title of run-1')).not.toBeInTheDocument();
  });

  it('reads again after a reconnect', async () => {
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-1'))]);
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of run-1');
    act(() => receive('connect'));
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-3'))]);

    act(() => receive('disconnect'));
    act(() => receive('connect'));

    expect(await screen.findByText('Title of run-3')).toBeInTheDocument();
  });

  it('keeps the lines shown when a read fails, and reads again on the next connect', async () => {
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-1'))]);
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Title of run-1');
    act(() => receive('connect'));
    vi.mocked(getDoneLately).mockRejectedValue(new Error('down'));
    act(() => receive('connect'));
    await vi.waitFor(() => expect(getDoneLately).toHaveBeenCalledTimes(2));
    await act(async () => undefined);

    expect(screen.getByText('Title of run-1')).toBeInTheDocument();
    expect(screen.queryByText('Could not load what got done.')).not.toBeInTheDocument();
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-4'))]);
    act(() => receive('connect'));
    expect(await screen.findByText('Title of run-4')).toBeInTheDocument();
  });

  it('reads again on the first connect after a read that failed', async () => {
    vi.mocked(getDoneLately).mockRejectedValueOnce(new Error('down'));
    vi.mocked(getDoneLately).mockResolvedValue([doneItem(mergedRun('run-1'))]);
    render(<DoneLately />, { wrapper: PartsWrapper });
    await screen.findByText('Could not load what got done.');

    act(() => receive('connect'));

    expect(await screen.findByText('Title of run-1')).toBeInTheDocument();
    expect(fakeSocket.listenerCount('done')).toBe(1);
  });
});

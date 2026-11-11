import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStats } from '../../lib/endpoints';
import { statsView } from '../../test/fixtures';
import { QueryWrapper } from '../../test/query-wrapper';
import { StatsSection } from './stats-section';
import { big, hours, ticks, usd } from './stats-format';

vi.mock('../../lib/endpoints', () => ({ getStats: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

const push = vi.fn();

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(getStats).mockResolvedValue(statsView());
});

function renderSection(): void {
  render(<StatsSection version="" />, { wrapper: QueryWrapper });
}

describe('StatsSection', () => {
  it('shows the totals of the last 30 days', async () => {
    renderSection();
    expect(await screen.findByLabelText('Runs: 4')).toBeInTheDocument();
    expect(screen.getByLabelText('Success rate: 67%')).toBeInTheDocument();
    expect(screen.getByLabelText('First-pass rate: 50%')).toBeInTheDocument();
    expect(screen.getByLabelText('Spend: $4.25')).toBeInTheDocument();
    expect(screen.getByLabelText('Returns: 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Usage limits: 2')).toBeInTheDocument();
    expect(screen.getByText(/runs started Nov 8 – Nov 10/)).toBeInTheDocument();
    expect(vi.mocked(getStats)).toHaveBeenCalledWith(30, expect.any(Number));
  });

  it('loads another range when one is picked', async () => {
    renderSection();
    await screen.findByLabelText('Runs: 4');
    await userEvent.setup().click(screen.getByRole('button', { name: 'All time' }));
    expect(vi.mocked(getStats)).toHaveBeenLastCalledWith(0, expect.any(Number));
  });

  it('shows one day of the runs chart under the pointer', async () => {
    renderSection();
    await screen.findByLabelText('Runs: 4');
    fireEvent.pointerEnter(screen.getByTestId('day-2026-11-10'));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Tue, Nov 10');
    expect(tip).toHaveTextContent('3started');
    expect(tip).toHaveTextContent('1failed');
  });

  it('groups the spend by model on request', async () => {
    renderSection();
    const money = await screen.findByRole('region', { name: 'Where the money goes' });
    expect(within(money).getAllByText('implement').length).toBeGreaterThan(0);
    expect(within(money).queryByText('model-a')).not.toBeInTheDocument();
    await userEvent.setup().click(within(money).getByRole('button', { name: 'Model' }));
    expect(within(money).getAllByText('model-a').length).toBeGreaterThan(0);
  });

  it('shows the share of finished runs that were merged, the closed count apart, and both charts', async () => {
    renderSection();
    expect(await screen.findByLabelText('Merged: 33%')).toBeInTheDocument();
    expect(screen.getByLabelText('Closed: 1')).toBeInTheDocument();
    const share = screen.getByRole('region', { name: 'Merge share per day' });
    expect(share).toHaveTextContent('33%');
    expect(share).toHaveTextContent('1 closed without a merge');
    const time = screen.getByRole('region', { name: 'Time to merge per day' });
    expect(time).toHaveTextContent('2.0 h');
    fireEvent.pointerEnter(screen.getByTestId('Time to merge per day-2026-11-08'));
    expect(within(time).getByRole('tooltip')).toHaveTextContent('2.0 hmedian to merge');
    fireEvent.pointerEnter(screen.getByTestId('Merge share per day-2026-11-10'));
    expect(within(share).getByRole('tooltip')).toHaveTextContent('1closed');
  });

  it('says so when no run was merged', async () => {
    const stats = statsView();
    vi.mocked(getStats).mockResolvedValue({
      ...stats,
      totals: { ...stats.totals, merged: 0, closed: 0, medianToMergeMs: null },
    });
    renderSection();
    expect(await screen.findByLabelText('Merged: 0%')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Time to merge per day' })).toHaveTextContent('no run has been merged');
  });

  it('says who sent work back, with CI by name', async () => {
    renderSection();
    const returns = await screen.findByRole('region', { name: 'Why work came back' });
    expect(within(returns).getByText('quality')).toBeInTheDocument();
    expect(within(returns).getByText('CI pipeline')).toBeInTheDocument();
  });

  it('lists the runs by spend, sorts them by a column, and opens one', async () => {
    renderSection();
    const user = userEvent.setup();
    const table = await screen.findByRole('region', { name: 'Runs' });
    const names = (): string[] =>
      within(table)
        .getAllByRole<HTMLTableRowElement>('row')
        .slice(1)
        .map((row) => row.cells[0].textContent ?? '');
    expect(names()).toEqual(['Add a stats page', 'Fix the bug', 'One pass']);
    await user.click(within(table).getByRole('button', { name: 'Started' }));
    expect(names()).toEqual(['One pass', 'Fix the bug', 'Add a stats page']);
    await user.click(within(table).getByText('Add a stats page'));
    expect(push).toHaveBeenCalledWith('/runs/run-a');
  });

  it('shows the edits each run made through the shell, sortable', async () => {
    renderSection();
    const user = userEvent.setup();
    const table = await screen.findByRole('region', { name: 'Runs' });
    await user.click(within(table).getByRole('button', { name: 'Edits through the shell' }));
    const first = within(table).getAllByRole<HTMLTableRowElement>('row')[1];
    expect(first.cells[0].textContent).toBe('Add a stats page');
    expect(first.cells[4].textContent).toBe('7');
  });

  it('shows only the runs of a day picked on the chart, until it is cleared', async () => {
    renderSection();
    const user = userEvent.setup();
    await screen.findByLabelText('Runs: 4');
    await user.click(screen.getByTestId('day-2026-11-08'));
    const table = screen.getByRole('region', { name: 'Runs started Sun, Nov 8' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Add a stats page')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Show every day' }));
    expect(screen.getByRole('region', { name: 'Runs' })).toBeInTheDocument();
  });

  it('says why the statistics are missing', async () => {
    vi.mocked(getStats).mockRejectedValue(new Error('api is down'));
    renderSection();
    expect(await screen.findByText(/Statistics are not available: api is down/)).toBeInTheDocument();
  });
});

describe('stats format', () => {
  it('shortens dollars, counts and hours', () => {
    expect([usd(0), usd(7.321), usd(183.4), usd(1234), usd(25_000)]).toEqual(['$0', '$7.32', '$183', '$1.2k', '$25k']);
    expect([big(950), big(12_400), big(28_000_000), big(2_329_000_000)]).toEqual(['950', '12k', '28M', '2.3B']);
    expect([hours(45 * 60_000), hours(150 * 60_000), hours(159 * 3_600_000)]).toEqual(['45 min', '2.5 h', '159 h']);
  });

  it('picks round ticks, whole ones for counts', () => {
    expect(ticks(17)).toEqual([0, 5, 10, 15, 20]);
    expect(ticks(3, { whole: true })).toEqual([0, 1, 2, 3]);
    expect(ticks(0)).toEqual([0, 1]);
  });
});

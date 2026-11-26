import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStats } from '../../lib/endpoints';
import { statsView } from '../../test/fixtures';
import { QueryWrapper } from '../../test/query-wrapper';
import { StatsSection } from './stats-section';
import { TILE_COLUMNS } from './stat-tiles';
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
    expect(screen.getByLabelText('Success rate: 66.7%')).toBeInTheDocument();
    expect(screen.getByLabelText('First-pass rate: 50.0%')).toBeInTheDocument();
    expect(screen.getByLabelText('Spend: $4.25')).toBeInTheDocument();
    expect(screen.getByLabelText('Returns: 50.0% came back')).toBeInTheDocument();
    expect(screen.getByLabelText('Usage limits: 2')).toBeInTheDocument();
    expect(screen.getByText(/runs started Nov 8 – Nov 10/)).toBeInTheDocument();
    expect(vi.mocked(getStats)).toHaveBeenCalledWith(30, expect.any(Number));
  });

  it('loads another range when one is picked', async () => {
    renderSection();
    await screen.findByLabelText('Runs: 4');
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'All time' }));
    expect(vi.mocked(getStats)).toHaveBeenLastCalledWith(0, expect.any(Number));
  });

  it('shows one day of the runs chart under the pointer', async () => {
    renderSection();
    await screen.findByLabelText('Runs: 4');
    const chart = screen.getByRole('region', { name: 'Tasks per day' });
    fireEvent.pointerEnter(within(chart).getByTestId('day-2026-11-10'));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Tue, Nov 10');
    expect(tip).toHaveTextContent('3started');
    expect(tip).toHaveTextContent('1failed');
  });

  it('shows the server stalls per day with their kinds in words, in the section named statistics', async () => {
    renderSection();
    await screen.findByLabelText('Runs: 4');
    expect(screen.getByRole('region', { name: 'Statistics' })).toHaveAttribute('id', 'statistics');
    expect(screen.getByText('Server stalls per day')).toBeInTheDocument();
    expect(screen.getByLabelText('Mon, Nov 9: 2 server blocked, 1 machine paused')).toBeInTheDocument();
  });

  it('groups the spend by model on request', async () => {
    renderSection();
    const money = await screen.findByRole('region', { name: 'Where the money goes' });
    expect(within(money).getAllByText('implement').length).toBeGreaterThan(0);
    expect(within(money).queryByText('model-a')).not.toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(within(money).getByRole('button', { name: 'Model' }));
    expect(within(money).getAllByText('model-a').length).toBeGreaterThan(0);
  });

  it('groups the spend by effort on request', async () => {
    vi.mocked(getStats).mockResolvedValue(
      statsView({
        efforts: [
          { name: 'high', usd: 2, tokens: 2000, count: 2 },
          { name: 'runtime default', usd: 1.75, tokens: 1300, count: 1 },
        ],
      }),
    );
    renderSection();
    const money = await screen.findByRole('region', { name: 'Where the money goes' });
    expect(within(money).queryByText('high')).not.toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(within(money).getByRole('button', { name: 'Effort' }));
    expect(within(money).getAllByText('high').length).toBeGreaterThan(0);
    expect(within(money).getByText('runtime default')).toBeInTheDocument();
    expect(within(money).queryByText('implement')).not.toBeInTheDocument();
  });

  it('shows the share of finished runs that were merged, the closed count apart, and both charts', async () => {
    renderSection();
    expect(await screen.findByLabelText('Merged: 33.3%')).toBeInTheDocument();
    expect(screen.getByLabelText('Closed: 1')).toBeInTheDocument();
    const share = screen.getByRole('region', { name: 'Merge share per day' });
    expect(share).toHaveTextContent('33.3%');
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
    expect(await screen.findByLabelText('Merged: 0.0%')).toBeInTheDocument();
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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
    const table = await screen.findByRole('region', { name: 'Runs' });
    await user.click(within(table).getByRole('button', { name: 'Edits through the shell' }));
    const first = within(table).getAllByRole<HTMLTableRowElement>('row')[1];
    expect(first.cells[0].textContent).toBe('Add a stats page');
    expect(first.cells[4].textContent).toBe('7');
  });

  it('shows only the runs of a day picked on the chart, until it is cleared', async () => {
    renderSection();
    const user = userEvent.setup({ delay: null });
    await screen.findByLabelText('Runs: 4');
    await user.click(within(screen.getByRole('region', { name: 'Epics per day' })).getByTestId('day-2026-11-08'));
    const table = screen.getByRole('region', { name: 'Runs started Sun, Nov 8' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Add a stats page')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Show every day' }));
    expect(screen.getByRole('region', { name: 'Runs' })).toBeInTheDocument();
  });

  it('opens the tasks of a day on the tasks chart, subtasks included, and no epic', async () => {
    renderSection();
    const user = userEvent.setup({ delay: null });
    await screen.findByLabelText('Runs: 4');
    await user.click(within(screen.getByRole('region', { name: 'Tasks per day' })).getByTestId('day-2026-11-10'));
    const table = screen.getByRole('region', { name: 'Runs started Tue, Nov 10' });

    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('A subtask that failed')).toBeInTheDocument();
    expect(within(table).getByText('One pass')).toBeInTheDocument();
    expect(within(table).queryByText('Add a stats page')).not.toBeInTheDocument();
  });

  it('says why the statistics are missing', async () => {
    vi.mocked(getStats).mockRejectedValueOnce(new Error('api is down'));
    renderSection();
    expect(await screen.findByText(/Statistics are not available: api is down/)).toBeInTheDocument();

    vi.mocked(getStats).mockResolvedValue(statsView());
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Runs: 4')).toBeInTheDocument();
    expect(screen.queryByText(/Statistics are not available/)).not.toBeInTheDocument();
  });

  it('fills whole rows of four columns from md up, so no row is part empty at 1280 and 1440 px', async () => {
    renderSection();
    const tile = await screen.findByLabelText('Runs: 4');
    const spans = [...(tile.parentElement?.children ?? [])].map((item) => Number(item.getAttribute('data-span')));

    expect(spans).toHaveLength(9);
    expect(spans.reduce((sum, span) => sum + span, 0) % TILE_COLUMNS).toBe(0);
    expect(spans.filter((span) => span === 2)).toHaveLength(3);
    const css = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
      .join('\n');
    expect(css).toMatch(
      new RegExp(`min-width:900px\\) \\{[^{]*\\{grid-template-columns: repeat\\(${TILE_COLUMNS}, minmax`),
    );
    expect(css).not.toContain('repeat(6');
  });

  it('shows the title of a run in the top runs, not its name', async () => {
    const view = statsView();
    vi.mocked(getStats).mockResolvedValue({
      ...view,
      runs: view.runs.map((run) => ({ ...run, name: `# ${run.key} raw prompt`, title: `Title of ${run.key}` })),
    });
    renderSection();
    const table = await screen.findByRole('region', { name: 'Runs' });

    expect(within(table).getByText('Title of run-a')).toBeInTheDocument();
    expect(within(table).queryByText(/raw prompt/)).not.toBeInTheDocument();
  });
});

describe('StatsSection epics and tasks', () => {
  it('opens with the epics and the tasks side by side, each with its medians and what is in progress', async () => {
    vi.mocked(getStats).mockResolvedValue(
      statsView({
        epics: { finished: 3, active: 2, failed: 0, medianUsd: 12.5, medianMs: 7_200_000, back: 1, medianReturns: 1 },
        tasks: { finished: 9, active: 4, failed: 1, medianUsd: 1.5, medianMs: 1_800_000, back: 2, medianReturns: 0 },
      }),
    );
    renderSection();

    const epics = await screen.findByRole('group', { name: 'Epics' });
    const tasks = screen.getByRole('group', { name: 'Tasks' });
    expect(epics).toHaveTextContent('3 finished');
    expect(epics).toHaveTextContent('median cost $12.50 · median time 2.0 h · 2 in progress');
    expect(tasks).toHaveTextContent('9 finished');
    expect(tasks).toHaveTextContent('median cost $1.50 · median time 30 min · 4 in progress');
    expect(epics.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the tasks per day and the epics per day as two cards, one under the other', async () => {
    renderSection();

    const tasks = await screen.findByRole('region', { name: 'Tasks per day' });
    const epics = screen.getByRole('region', { name: 'Epics per day' });
    expect(tasks.compareDocumentPosition(epics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tasks.parentElement).toBe(epics.parentElement);
    expect(within(tasks).getByText('4 tasks')).toBeInTheDocument();
    expect(within(epics).getByText('1 epic')).toBeInTheDocument();
    expect(screen.queryByText('Runs per day')).not.toBeInTheDocument();
  });

  it('puts the money and the returns cards in one column', async () => {
    renderSection();

    const money = await screen.findByRole('region', { name: 'Where the money goes' });
    const returns = screen.getByRole('region', { name: 'Why work came back' });
    expect(money.parentElement).toBe(returns.parentElement?.parentElement);
  });
});

describe('StatsSection tasks and returns', () => {
  const week = ['05', '06', '07', '08', '09', '10', '11'].map((date) => ({
    ...statsView().days[1],
    day: `2026-11-${date}`,
  }));

  function totals(overrides: Partial<ReturnType<typeof statsView>['totals']>) {
    return { ...statsView().totals, ...overrides };
  }

  it('says how many tasks came back, how often most do, and where the returns came from', async () => {
    vi.mocked(getStats).mockResolvedValue(
      statsView({
        days: week,
        tasks: { ...statsView().tasks, finished: 4, back: 3, medianReturns: 1 },
        totals: totals({
          returnsByKind: [
            { kind: 'checks', returns: 2 },
            { kind: 'review', returns: 2 },
            { kind: 'pipeline', returns: 1 },
          ],
        }),
      }),
    );
    renderSection();

    const tile = await screen.findByLabelText('Returns: 75.0% came back');
    expect(tile).toHaveTextContent(
      'most come back once · 5 returns in 7 days: 2 from checks, 2 from reviewers, 1 from CI',
    );
  });

  it.each([
    [0, 'most pass first time'],
    [2, 'most come back 2 times'],
  ])('puts a median of %i returns per task in words', async (median, words) => {
    vi.mocked(getStats).mockResolvedValue(statsView({ tasks: { ...statsView().tasks, medianReturns: median } }));
    renderSection();

    expect(await screen.findByLabelText(/^Returns: /)).toHaveTextContent(words);
  });

  it('names the period of the spend, what a task costs, and keeps the last day label whole', async () => {
    vi.mocked(getStats).mockResolvedValue(
      statsView({
        days: week.map((day, index) => ({ ...day, usd: [0, 0, 0, 0, 100, 78.41, 71.59][index] })),
        totals: totals({ usd: 250 }),
        tasks: { ...statsView().tasks, medianUsd: 4 },
      }),
    );
    renderSection();

    const card = await screen.findByRole('region', { name: 'Spend' });
    expect(within(card).getByText('$250 in 7 days')).toBeInTheDocument();
    expect(
      within(card).getByText('$83.33 per working day · $4.00 per task (median) · peak $100 on Nov 9'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Nov 11')).toHaveAttribute('text-anchor', 'end');
  });

  it('shows the returns CI caught alone with the jobs and how often, and the commands checks failed on', async () => {
    vi.mocked(getStats).mockResolvedValue(
      statsView({
        reasons: [
          { name: 'checks', returns: 3, commands: [{ name: 'npm run lint', returns: 2 }] },
          { name: 'pipeline', returns: 3 },
        ],
        ciReturns: { only: 2, withChecks: 1, jobs: [{ name: 'docker', returns: 2 }] },
      }),
    );
    renderSection();

    const card = await screen.findByRole('region', { name: 'Why work came back' });
    expect(within(card).getByText('CI only: 2 · CI and checks: 1')).toBeInTheDocument();
    expect(within(card).queryByRole('list', { name: 'CI-only jobs' })).not.toBeInTheDocument();
    expect(within(card).queryByText('npm run lint')).not.toBeInTheDocument();

    await userEvent.setup({ delay: null }).click(within(card).getByText('CI only: 2 · CI and checks: 1'));
    expect(within(within(card).getByRole('list', { name: 'CI-only jobs' })).getByText('docker')).toBeInTheDocument();

    await userEvent.setup({ delay: null }).click(within(card).getByLabelText(/^checks: 3/));
    expect(within(card).getByText('npm run lint')).toBeInTheDocument();
  });

  it('cuts a long command to one line with its whole text on hover', async () => {
    const command = `npm run lint ${'--max-warnings=0 '.repeat(8)}`.trim();
    expect(command.length).toBeGreaterThanOrEqual(120);
    vi.mocked(getStats).mockResolvedValue(
      statsView({ reasons: [{ name: 'checks', returns: 3, commands: [{ name: command, returns: 2 }] }] }),
    );
    renderSection();

    const card = await screen.findByRole('region', { name: 'Why work came back' });
    await userEvent.setup({ delay: null }).click(within(card).getByLabelText(/^checks: 3/));
    const name = within(card).getByText(command);
    expect(name).toHaveAttribute('title', command);
    expect(name).toHaveStyle({ whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
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

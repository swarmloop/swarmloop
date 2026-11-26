import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { Shell } from '../features/shell';
import { listBacklogs } from '../lib/backlog-endpoints';
import { getFlow, getReadiness, getStats, listRuns } from '../lib/endpoints';
import { activeMilestoneBacklog } from '../test/backlog-fixtures';
import { receive } from '../test/fake-socket';
import { statsView } from '../test/fixtures';
import { mergedRun, questionRun, returnsFlow, workingRun } from '../test/overview-fixtures';
import { QueryWrapper } from '../test/query-wrapper';
import { listRunsFrom, runsPage } from '../test/runs-page';
import HomePage from './page';

vi.mock('../lib/endpoints', () => ({ getReadiness: vi.fn(), getStats: vi.fn(), listRuns: vi.fn(), getFlow: vi.fn() }));
vi.mock('../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

const ready = {
  items: [{ id: 'docker' as const, status: 'ok' as const, line: 'docker is running', short: 'running', action: '' }],
  checkedAt: null,
};

function load(runs: Parameters<typeof listRunsFrom>[0]): void {
  vi.mocked(listRuns).mockImplementation(listRunsFrom(runs));
}

function range(days: number) {
  const week = days === 7;
  return statsView({
    totals: {
      ...statsView().totals,
      merged: week ? 3 : 12,
      requirementsMet: week ? 41 : 90,
      requirementsTotal: week ? 41 : 100,
      caughtAndFixed: week ? 5 : 20,
      personMessages: week ? 7 : 30,
      usd: week ? 142.4 : 980,
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.innerWidth = 1440;
  window.innerHeight = 900;
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(getReadiness).mockResolvedValue(ready);
  vi.mocked(getStats).mockImplementation((days) => Promise.resolve(range(days)));
  vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, [])));
  vi.mocked(listBacklogs).mockResolvedValue([]);
  load([]);
});

function renderPage() {
  return render(
    <ReadinessProvider>
      <Shell onNewRun={vi.fn()}>
        <HomePage />
      </Shell>
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

const manyRuns = () => [
  ...Array.from({ length: 4 }, (_, index) => questionRun(`ask-${index}`)),
  ...Array.from({ length: 8 }, (_, index) => workingRun(`work-${index}`)),
  ...Array.from({ length: 7 }, (_, index) => mergedRun(`done-${index}`)),
];

describe('Overview page', () => {
  it('orders the parts and caps the cards and lines', async () => {
    load(manyRuns());
    renderPage();
    await screen.findByText('Title of done-0');
    const names = ['Needs you', 'Numbers', 'Now', 'Done lately'];
    const sections = names.map((name) => screen.getByRole('region', { name }));
    sections.forEach((section, index) => {
      if (index > 0) {
        expect(sections[index - 1].compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });
    const footer = screen.getByRole('contentinfo');
    expect(sections[3].compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sections[0]).getAllByRole('link', { name: /Answer|Open|Resume|Run/ })).toHaveLength(3);
    expect(within(sections[2]).getAllByText(/^Title of work-/)).toHaveLength(6);
    expect(within(sections[3]).getAllByRole('listitem')).toHaveLength(5);
  });

  it('sizes the page root to the viewport so nothing scrolls', async () => {
    renderPage();
    const root = screen.getByRole('heading', { name: 'Overview' }).parentElement as HTMLElement;
    // At least the viewport below the app bar, and free to grow: a fixed height would clip content that needs more.
    expect(getComputedStyle(root).minHeight).toContain('100vh');
    expect(getComputedStyle(root).height).toBe('');
    await screen.findByText('Merged');
  });

  it('shows the five figures in order with their labels and links', async () => {
    renderPage();
    await screen.findByText('41/41');
    const tiles = within(screen.getByRole('region', { name: 'Numbers' })).getAllByRole('link');
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      '3Merged',
      '41/41Requirements met',
      '5Caught and fixed',
      '7Your input',
      '$142Cost',
    ]);
    expect(tiles.map((tile) => tile.getAttribute('href'))).toEqual([
      '/?show=done',
      '/stats#returns',
      '/stats#returns',
      '/?show=done',
      '/stats',
    ]);
  });

  it('switches the range to This month and keeps it after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    expect(await screen.findByText('41/41')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This week' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'This month' }));
    expect(await screen.findByText('90/100')).toBeInTheDocument();
    unmount();
    renderPage();
    expect(await screen.findByText('90/100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This month' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows 0, Nothing running, the New run hint and Connect with no runs', async () => {
    vi.mocked(getStats).mockResolvedValue(statsView({ totals: { ...statsView().totals, merged: 0, usd: 0 } }));
    renderPage();
    act(() => receive('runs', runsPage([], { part: 'active' })));
    expect(await screen.findByText('Nothing running')).toBeInTheDocument();
    expect(await screen.findByText('No runs yet. New run, top right, starts one.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect GitHub or GitLab' })).toBeInTheDocument();
    expect(await screen.findAllByText('0')).not.toHaveLength(0);
  });

  it('links the footer and reads Everything is ready', async () => {
    renderPage();
    expect(await screen.findByText('Everything is ready')).toBeInTheDocument();
    const footer = within(screen.getByRole('contentinfo'));
    const links = ['Stats', 'Runs', 'Backlogs', 'Settings', 'Connections'].map((name) =>
      footer.getByRole('link', { name }).getAttribute('href'),
    );
    expect(links).toEqual(['/stats', '/', '/backlogs', '/settings', '/connections']);
  });

  it('shows the readiness panel when a check fails', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'fail', line: 'docker is not running', short: 'not running', action: 'start Docker' },
      ],
      checkedAt: null,
    });
    renderPage();
    expect(await screen.findByText('A run cannot start yet')).toBeInTheDocument();
    expect(screen.queryByText('Everything is ready')).not.toBeInTheDocument();
  });

  it('shows no statistics section or chart and no agent time', async () => {
    load([...manyRuns()]);
    vi.mocked(listBacklogs).mockResolvedValue([activeMilestoneBacklog('shop')]);
    renderPage();
    await screen.findByText('41/41');
    expect(screen.queryByRole('region', { name: 'Statistics' })).not.toBeInTheDocument();
    expect(screen.queryByText('Runs per day')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent time')).not.toBeInTheDocument();
    expect(screen.queryByText('First-pass rate')).not.toBeInTheDocument();
  });

  /** Every size that text on the page has. Icon titles are tooltips, not text on the page. jsdom does not inherit, so a size comes from the nearest ancestor that sets one. */
  function textSizes(): string[] {
    const sizeOf = (element: HTMLElement | null): string =>
      element === null ? '' : getComputedStyle(element).fontSize || sizeOf(element.parentElement);
    const sizes = new Set<string>();
    for (const element of document.body.querySelectorAll<HTMLElement>('*:not(svg *)')) {
      if ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) {
        sizes.add(sizeOf(element));
      }
    }
    return [...sizes].sort();
  }

  it('uses at most three text sizes', async () => {
    load(manyRuns());
    renderPage();
    await screen.findByText('Title of done-0');
    await screen.findByText('Everything is ready');
    expect(textSizes()).toEqual(['0.75rem', '0.875rem', '40px']);
  });

  it.each([
    ['with a warning', 'warn', 'Ready, with warnings'],
    ['with a failure', 'fail', 'A run cannot start yet'],
  ] as const)('uses at most three text sizes %s', async (_name, status, title) => {
    load(manyRuns());
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status, line: 'docker is not running', short: 'not running', action: 'start Docker' }],
      checkedAt: null,
    });
    renderPage();
    await screen.findByText('Title of done-0');
    await screen.findByText(title);
    expect(textSizes()).toEqual(['0.75rem', '0.875rem', '40px']);
  });

  it('reads the runs once per live change for all three parts', async () => {
    const rows = [questionRun('ask-0'), workingRun('work-0'), mergedRun('done-0')];
    const served: string[] = [];
    vi.mocked(listRuns).mockImplementation((query) => {
      if (query.cursor === undefined) {
        served.push(query.part);
      }
      return listRunsFrom(rows)(query);
    });
    renderPage();
    await screen.findByText('Title of done-0');
    const count = (part: string): number => served.filter((name) => name === part).length;
    const before = { active: count('active'), done: count('done') };

    const changed = rows.map((row) =>
      row.key === 'work-0' ? { ...row, title: 'Changed work', status: 'done' as const } : row,
    );
    act(() => receive('runs', runsPage(changed, { part: 'active' })));

    await vi.waitFor(() => expect(count('done')).toBe(before.done + 1));
    expect(count('active')).toBe(before.active + 1);
    expect(served).toHaveLength(before.active + before.done + 2);
  });

  it('keeps the rows the parts showed when the read after a live change fails', async () => {
    load(manyRuns());
    renderPage();
    await screen.findByText('Title of done-0');
    vi.mocked(listRuns).mockRejectedValue(new Error('down'));
    // The query cache tells its components through a timer, so the failed read settles under fake time.
    vi.useFakeTimers();
    try {
      act(() => receive('runs', runsPage([workingRun('work-0', { status: 'done' })], { part: 'active' })));
      await act(() => vi.advanceTimersByTimeAsync(10));
    } finally {
      vi.useRealTimers();
    }
    expect(screen.queryByText('Could not load what got done.')).not.toBeInTheDocument();
    expect(screen.getAllByText('Title of done-0').length).toBeGreaterThan(0);
  });
});

import { render, screen, within } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { Shell } from '../features/shell';
import { listBacklogs } from '../lib/backlog-endpoints';
import { getFlow, getReadiness, getSession, getStats, listProjects, listRuns } from '../lib/endpoints';
import { activeMilestoneBacklog, proposedMilestoneBacklog } from '../test/backlog-fixtures';
import { statsView } from '../test/fixtures';
import { mergedRun, questionRun, returnsFlow, workingRun } from '../test/overview-fixtures';
import { QueryWrapper } from '../test/query-wrapper';
import { listRunsFrom } from '../test/runs-page';
import { DashboardShell } from './dashboard-shell';
import HomePage from './page';

vi.mock('../lib/endpoints', () => ({
  getReadiness: vi.fn(),
  getStats: vi.fn(),
  listRuns: vi.fn(),
  getFlow: vi.fn(),
  getSession: vi.fn(),
  listProjects: vi.fn(),
  removeRun: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());
vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));

const item = (status: 'ok' | 'warn' | 'fail') => ({
  id: 'docker' as const,
  status,
  line: 'docker says so',
  action: 'start Docker',
});

/** The fullest Overview: three needs, six working items, five finished lines. */
function fullest(): void {
  vi.mocked(listRuns).mockImplementation(
    listRunsFrom([
      ...Array.from({ length: 3 }, (_, index) => questionRun(`ask-${index}`)),
      ...Array.from({ length: 6 }, (_, index) => workingRun(`work-${index}`)),
      ...Array.from({ length: 5 }, (_, index) => mergedRun(`done-${index}`)),
    ]),
  );
  vi.mocked(listBacklogs).mockResolvedValue([activeMilestoneBacklog('shop'), proposedMilestoneBacklog('lab')]);
}

beforeEach(() => {
  window.localStorage.clear();
  window.innerWidth = 1440;
  window.innerHeight = 900;
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue('/');
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>);
  vi.mocked(getSession).mockResolvedValue({ user: null });
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(getStats).mockResolvedValue(statsView());
  vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, [])));
  fullest();
});

/** A one-line title may end in an ellipsis and a progress bar trims its fill, an alert keeps MUI's own auto overflow on text that wraps; no other box may clip or scroll. */
function expectNothingClipped(root: HTMLElement): void {
  for (const element of [
    root,
    ...root.querySelectorAll<HTMLElement>(
      '*:not(.MuiTypography-noWrap):not(.MuiLinearProgress-root):not(title):not(.MuiAlert-message)',
    ),
  ]) {
    const style = getComputedStyle(element);
    expect(style.overflow === '' || style.overflow === 'visible', element.outerHTML.slice(0, 80)).toBe(true);
    expect(style.display, element.outerHTML.slice(0, 120)).not.toBe('none');
  }
  expect(getComputedStyle(root).height).toBe('');
}

describe('Overview layout at 1440x900', () => {
  // jsdom has no layout engine and the project has no browser, so pixels cannot be measured here. What is checked: the
  // page lies in the real dashboard frame, grows with its content, no box on it clips or scrolls, and every part is there.
  it.each([
    ['ready', 'ok'],
    ['with a warning', 'warn'],
    ['with a failure', 'fail'],
  ] as const)('keeps every part visible and nothing clipped or scrolling inside, %s', async (_name, status) => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [item(status)], checkedAt: null });
    render(
      <ReadinessProvider>
        <Shell onNewRun={vi.fn()}>
          <HomePage />
        </Shell>
      </ReadinessProvider>,
      { wrapper: QueryWrapper },
    );
    await screen.findByText('Title of done-0');
    await screen.findByText('Checkout');
    const root = screen.getByRole('heading', { name: 'Overview' }).parentElement as HTMLElement;
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getAllByRole('link', { name: /Answer|Open/ })).toHaveLength(3);
    expect(within(screen.getByRole('region', { name: 'Numbers' })).getAllByRole('link')).toHaveLength(5);
    const now = screen.getByRole('region', { name: 'Now' });
    expect(within(now).getAllByText(/^Title of work-|^Checkout$/)).toHaveLength(6);
    expect(within(screen.getByRole('region', { name: 'Done lately' })).getAllByRole('listitem')).toHaveLength(5);
    expect(
      within(screen.getByRole('contentinfo')).getAllByRole('link', {
        name: /Stats|Runs|Backlogs|Settings|Connections/,
      }),
    ).toHaveLength(5);
    expectNothingClipped(root);
  });

  it('fits the fullest page with a failing readiness report into the real frame at 1440x900', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [item('fail')], checkedAt: null });
    render(
      <ThemeProvider theme={createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } })}>
        <ReadinessProvider>
          <DashboardShell>
            <HomePage />
          </DashboardShell>
        </ReadinessProvider>
      </ThemeProvider>,
      { wrapper: QueryWrapper },
    );
    const root = (await screen.findByRole('heading', { name: 'Overview' })).parentElement as HTMLElement;
    // The drawer lists the same runs, so each part is read inside its own region.
    const done = screen.getByRole('region', { name: 'Done lately' });
    await within(done).findByText('Title of done-0');
    const now = screen.getByRole('region', { name: 'Now' });
    await within(now).findByText('Checkout');
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getAllByRole('link', { name: /Answer|Open/ })).toHaveLength(3);
    expect(within(screen.getByRole('region', { name: 'Numbers' })).getAllByRole('link')).toHaveLength(5);
    expect(within(now).getAllByText(/^Title of work-|^Checkout$/)).toHaveLength(6);
    expect(within(done).getAllByRole('listitem')).toHaveLength(5);
    expect(await within(screen.getByRole('contentinfo')).findByText('A run cannot start yet')).toBeInTheDocument();
    expect(getComputedStyle(root).maxHeight).toBe('calc(100vh - 112px)');
    expectNothingClipped(root);
  });
});

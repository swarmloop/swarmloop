import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../lib/backlog-endpoints';
import { getSession, listProjects, listRemote, listRuns } from '../lib/endpoints';
import { backlogView } from '../test/backlog-fixtures';
import { fakeIntersectionObserver } from '../test/intersection-observer';
import { QueryWrapper } from '../test/query-wrapper';
import { listRunsFrom } from '../test/runs-page';
import { mediaWidth } from '../test/viewport';
import { DashboardShell } from './dashboard-shell';

vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('../lib/endpoints', () => ({
  listRuns: vi.fn(),
  removeRun: vi.fn(),
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  getSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn(), createBacklog: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });

function renderShell(): void {
  render(
    <ThemeProvider theme={theme}>
      <QueryWrapper>
        <DashboardShell>
          <p>page content</p>
        </DashboardShell>
      </QueryWrapper>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ user: null });
  vi.mocked(usePathname).mockReturnValue('/backlogs/swarmloop');
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>);
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(listRuns).mockImplementation(listRunsFrom([]));
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
  vi.mocked(listBacklogs).mockResolvedValue([backlogView()]);
});

fakeIntersectionObserver();

describe('Shell on the Backlogs tab at desktop width', () => {
  mediaWidth(1280);

  it('puts Backlogs next to Runs and shows the backlog list in the drawer', async () => {
    renderShell();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Runs', 'Backlogs']);
    expect(within(nav).getByRole('link', { name: 'Backlogs' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Runs' })).not.toHaveAttribute('aria-current');
    expect(await screen.findByRole('link', { name: /swarmloop.*M3 · 4\/7/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the list of backlogs' })).not.toBeInTheDocument();
  });
});

describe('Shell on the Backlogs tab at 375 px', () => {
  mediaWidth(375);

  it('keeps the list in a temporary drawer opened by a button', async () => {
    renderShell();

    expect(screen.queryByRole('link', { name: /swarmloop.*M3/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open the list of backlogs' }));
    expect(await screen.findByRole('link', { name: /swarmloop.*M3 · 4\/7/ })).toBeInTheDocument();
  });
});

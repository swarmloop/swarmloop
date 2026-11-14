import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, listProjects, listRemote, listRuns, removeRun } from '../lib/endpoints';
import { receive } from '../test/fake-socket';
import { runSummary } from '../test/fixtures';
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
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });
const push = vi.fn();
const replace = vi.fn();

function renderShell(): void {
  render(
    <ThemeProvider theme={theme}>
      <DashboardShell>
        <p>page content</p>
      </DashboardShell>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ user: null });
  vi.mocked(usePathname).mockReturnValue('/');
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>);
  vi.mocked(useRouter).mockReturnValue({ push, replace } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });
  vi.mocked(removeRun).mockResolvedValue({ key: 'run-1' });
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
});

describe('Shell', () => {
  it('shows offline until the socket connects, then live', async () => {
    renderShell();

    expect(await screen.findByText('offline')).toBeInTheDocument();

    act(() => receive('connect'));

    expect(await screen.findByText('live')).toBeInTheDocument();
  });

  it('shows the user and Logout only when there is a session', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat' });
    renderShell();

    await userEvent.setup().click(await screen.findByRole('button', { name: /octocat/ }));

    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });

  it('draws no shell on the login page', async () => {
    vi.mocked(usePathname).mockReturnValue('/login');
    renderShell();

    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New run' })).not.toBeInTheDocument();
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('links the logo and the name to the overview', async () => {
    renderShell();

    expect(await screen.findByRole('link', { name: 'swarmloop, overview' })).toHaveAttribute('href', '/');
  });

  it('opens the new run dialog from the New run button', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'New run' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New run' })).toBeInTheDocument();
  });

  it('removes a run with DELETE, and goes to / when the open run is the one removed', async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue('/runs/run-1');
    renderShell();

    fireEvent.mouseEnter(await screen.findByText('Run one'));
    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove Run one?' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(removeRun).toHaveBeenCalledWith('run-1');
  });
  describe('run filter', () => {
    const fixture = () => [
      runSummary(),
      ...[1, 2].map((n) => ({
        ...runSummary(),
        key: `f-${n}`,
        name: `Failed ${n}`,
        status: 'failed',
        state: 'failed' as const,
      })),
      ...Array.from({ length: 134 }, (_, n) => ({
        ...runSummary(),
        key: `m-${n}`,
        name: `Merged ${n}`,
        state: 'merged' as const,
      })),
    ];

    it('opens on Active with the counts and shows only the active runs', async () => {
      vi.mocked(listRuns).mockResolvedValue({ runs: fixture() });
      renderShell();

      expect(await screen.findByRole('button', { name: 'Active 3' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Done 134' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All 137' })).toBeInTheDocument();
      expect(screen.getByText('Run one')).toBeInTheDocument();
      expect(screen.getByText('Failed 2')).toBeInTheDocument();
      expect(screen.queryByText('Merged 0')).not.toBeInTheDocument();
    });

    it('opens on Done when the address says ?show=done', async () => {
      vi.mocked(listRuns).mockResolvedValue({ runs: fixture() });
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('show=done') as unknown as ReturnType<typeof useSearchParams>,
      );
      renderShell();

      expect(await screen.findByText('Merged 0')).toBeInTheDocument();
      expect(screen.queryByText('Run one')).not.toBeInTheDocument();
    });

    it('shows every run on ?show=all', async () => {
      vi.mocked(listRuns).mockResolvedValue({ runs: fixture() });
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('show=all') as unknown as ReturnType<typeof useSearchParams>,
      );
      renderShell();

      expect(await screen.findByText('Merged 0')).toBeInTheDocument();
      expect(screen.getByText('Run one')).toBeInTheDocument();
    });

    it('writes the chosen part to the address', async () => {
      const user = userEvent.setup();
      vi.mocked(listRuns).mockResolvedValue({ runs: fixture() });
      renderShell();

      await user.click(await screen.findByRole('button', { name: 'Done 134' }));
      expect(replace).toHaveBeenLastCalledWith('/?show=done');
      await user.click(screen.getByRole('button', { name: 'All 137' }));
      expect(replace).toHaveBeenLastCalledWith('/?show=all');
    });

    describe('keeps the chosen part when it leaves the list page', () => {
      const merged = { ...runSummary(), key: 'm-0', name: 'Merged 0', state: 'merged' as const };
      const showing = (show: string) =>
        vi
          .mocked(useSearchParams)
          .mockReturnValue(new URLSearchParams(show) as unknown as ReturnType<typeof useSearchParams>);

      it('opens a run with ?show= in the address, so the run stays in the list', async () => {
        const user = userEvent.setup();
        vi.mocked(listRuns).mockResolvedValue({ runs: [merged] });
        showing('show=done');
        renderShell();

        await user.click(await screen.findByText('Merged 0'));

        expect(push).toHaveBeenCalledWith('/runs/m-0?show=done');
      });

      it('opens a run with nothing added while the address has no part', async () => {
        const user = userEvent.setup();
        renderShell();

        await user.click(await screen.findByText('Run one'));

        expect(push).toHaveBeenCalledWith('/runs/run-1');
      });

      it('goes back to the list with ?show= in the address after the open run is removed', async () => {
        const user = userEvent.setup();
        vi.mocked(listRuns).mockResolvedValue({ runs: [merged] });
        vi.mocked(removeRun).mockResolvedValue({ key: 'm-0' });
        vi.mocked(usePathname).mockReturnValue('/runs/m-0');
        showing('show=done');
        renderShell();

        fireEvent.mouseEnter(await screen.findByText('Merged 0'));
        await user.click(await screen.findByRole('button', { name: 'Remove Merged 0' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

        await waitFor(() => expect(push).toHaveBeenCalledWith('/?show=done'));
      });

      it('keeps only a known part of the address, never another query', async () => {
        const user = userEvent.setup();
        showing('show=nope&q=secret');
        renderShell();

        await user.click(await screen.findByText('Run one'));

        expect(push).toHaveBeenCalledWith('/runs/run-1?show=active');
      });
    });

    it('counts an epic with a running task once, in Active', async () => {
      vi.mocked(listRuns).mockResolvedValue({
        runs: [
          { ...runSummary(), key: 'e-1', name: 'Epic', status: 'waiting', state: 'waiting' as const },
          { ...runSummary(), key: 'e-1-A', name: 'Epic task', parentKey: 'e-1' },
        ],
      });
      renderShell();

      expect(await screen.findByRole('button', { name: 'Active 1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All 1' })).toBeInTheDocument();
    });

    it('finds a run by a word of its name', async () => {
      const user = userEvent.setup();
      vi.mocked(listRuns).mockResolvedValue({ runs: fixture() });
      renderShell();

      await user.type(await screen.findByPlaceholderText('Filter runs'), 'failed 2');

      expect(screen.getByText('Failed 2')).toBeInTheDocument();
      expect(screen.queryByText('Failed 1')).not.toBeInTheDocument();
    });
  });
});

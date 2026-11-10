import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listProjects, listRuns, removeRun } from '../lib/endpoints';
import { receive } from '../test/fake-socket';
import { runSummary } from '../test/fixtures';
import { DashboardShell } from './dashboard-shell';

vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: vi.fn() }));
vi.mock('../lib/endpoints', () => ({
  listRuns: vi.fn(),
  removeRun: vi.fn(),
  listProjects: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
}));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });
const push = vi.fn();

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
  vi.mocked(usePathname).mockReturnValue('/');
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });
  vi.mocked(removeRun).mockResolvedValue({ key: 'run-1' });
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
});

describe('Shell', () => {
  it('shows offline until the socket connects, then live', async () => {
    renderShell();

    expect(await screen.findByText('offline')).toBeInTheDocument();

    act(() => receive('connect'));

    expect(await screen.findByText('live')).toBeInTheDocument();
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

    await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove Run one?' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(removeRun).toHaveBeenCalledWith('run-1');
  });
});

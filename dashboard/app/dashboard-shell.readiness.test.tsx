import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { getReadiness, getSession, listProjects, listRuns } from '../lib/endpoints';
import { listRunsFrom } from '../test/runs-page';
import { mediaWidth } from '../test/viewport';
import { QueryWrapper } from '../test/query-wrapper';
import { DashboardShell } from './dashboard-shell';

vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('../lib/endpoints', () => ({
  getReadiness: vi.fn(),
  listRuns: vi.fn(),
  listProjects: vi.fn(),
  removeRun: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  getSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });

function renderShell(): void {
  render(
    <ThemeProvider theme={theme}>
      <ReadinessProvider>
        <DashboardShell>
          <p>page content</p>
        </DashboardShell>
      </ReadinessProvider>
    </ThemeProvider>,
    { wrapper: QueryWrapper },
  );
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ user: null });
  vi.mocked(usePathname).mockReturnValue('/');
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>);
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(listRuns).mockImplementation(listRunsFrom([]));
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
});

describe('DashboardShell readiness', () => {
  it('disables the header New run with the action while an item fails, and keeps the page usable', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'fail', line: 'docker is not running', short: 'not running', action: 'start Docker' },
      ],
      checkedAt: null,
    });
    renderShell();
    expect(await screen.findByTitle('start Docker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New run' })).toBeDisabled();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('keeps the header New run enabled when the report cannot be read', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    renderShell();
    await screen.findByText('page content');
    expect(screen.getByRole('button', { name: 'New run' })).toBeEnabled();
  });

  it('shows Needs attention on Connections in the open account menu when a readiness item fails', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', provider: 'github' });
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'fail', line: 'docker is not running', short: 'not running', action: 'start Docker' },
      ],
      checkedAt: null,
    });
    renderShell();
    await userEvent.setup({ delay: null }).click(await screen.findByRole('button', { name: /octocat/ }));

    expect(await screen.findByRole('menuitem', { name: 'Connections' })).toHaveTextContent('Needs attention');
  });

  it.each(['/', '/runs/x'])('shows the readiness status in the header on %s', async (path) => {
    vi.mocked(usePathname).mockReturnValue(path);
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'fail', line: 'docker is not running', short: 'not running', action: 'start Docker' },
      ],
      checkedAt: null,
    });
    renderShell();
    expect(await screen.findByRole('link', { name: '1 setup problem' })).toHaveAttribute('href', '/#readiness');
    expect(await screen.findAllByTitle('start Docker')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'New run' })).toBeDisabled();
  });
});

describe('DashboardShell readiness at 375 px', () => {
  mediaWidth(375);

  it('disables the New run icon button with the action as its title and shows the status in the drawer', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'fail', line: 'docker is not running', short: 'not running', action: 'start Docker' },
      ],
      checkedAt: null,
    });
    renderShell();

    expect(await screen.findByTitle('start Docker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New run' })).toBeDisabled();
    expect(screen.queryByText('1 setup problem')).not.toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Open the list of runs' }));
    expect(await screen.findByText('1 setup problem')).toBeInTheDocument();
  });
});

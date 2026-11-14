import { render, screen } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { getReadiness, getSession, listProjects, listRuns } from '../lib/endpoints';
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
  vi.mocked(listRuns).mockResolvedValue({ runs: [] });
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
});

describe('DashboardShell readiness', () => {
  it('disables the header New run with the action while an item fails, and keeps the page usable', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'fail', line: 'docker is not running', action: 'start Docker' }],
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

  it.each(['/', '/runs/x'])('shows the readiness status in the header on %s', async (path) => {
    vi.mocked(usePathname).mockReturnValue(path);
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'fail', line: 'docker is not running', action: 'start Docker' }],
      checkedAt: null,
    });
    renderShell();
    expect(await screen.findByRole('link', { name: '1 setup problem' })).toHaveAttribute('href', '/#readiness');
    expect(await screen.findAllByTitle('start Docker')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'New run' })).toBeDisabled();
  });
});

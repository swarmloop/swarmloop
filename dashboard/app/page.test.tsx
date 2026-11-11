import { render, screen } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { Shell } from '../features/shell';
import { getReadiness, getStats } from '../lib/endpoints';
import { statsView } from '../test/fixtures';
import { QueryWrapper } from '../test/query-wrapper';
import HomePage from './page';

vi.mock('../lib/endpoints', () => ({ getReadiness: vi.fn(), getStats: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(getStats).mockResolvedValue(statsView());
});

function renderPage(): void {
  render(
    <ReadinessProvider>
      <Shell onNewRun={vi.fn()}>
        <HomePage />
      </Shell>
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

describe('HomePage', () => {
  it('offers Connect in the empty state', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByRole('link', { name: 'Connect GitHub or GitLab' })).toHaveAttribute(
      'href',
      '/connections',
    );
  });

  it('spells out the action of a failing check', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'fail', line: 'docker is not running', action: 'start Docker' }],
    });
    renderPage();
    expect(await screen.findByText(/docker is not running/)).toHaveTextContent('start Docker');
    expect(screen.getByText('A run cannot start yet')).toBeInTheDocument();
  });

  it('says why the checks are missing when the report cannot be read', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it('shows the statistics under the checks', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [] });
    renderPage();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Runs: 4')).toBeInTheDocument();
  });
});

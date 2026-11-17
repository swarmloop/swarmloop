import { act, render, screen } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { Shell } from '../features/shell';
import { getReadiness, getStats } from '../lib/endpoints';
import { receive } from '../test/fake-socket';
import { runSummary, statsView } from '../test/fixtures';
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
    vi.mocked(getReadiness).mockResolvedValue({ items: [], checkedAt: null });
    renderPage();
    act(() => receive('runs', { runs: [] }));
    expect(await screen.findByRole('link', { name: 'Connect GitHub or GitLab' })).toHaveAttribute(
      'href',
      '/connections',
    );
  });

  it('spells out the action of a failing check', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'fail', line: 'docker is not running', action: 'start Docker' }],
      checkedAt: null,
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
    vi.mocked(getReadiness).mockResolvedValue({ items: [], checkedAt: null });
    renderPage();
    act(() => receive('runs', { runs: [] }));
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Runs: 4')).toBeInTheDocument();
  });
});

describe('HomePage run line', () => {
  beforeEach(() => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [], checkedAt: null });
  });

  it('shows a skeleton and no empty text or connect button until the runs are loaded', async () => {
    renderPage();

    expect(screen.getByLabelText('Loading runs')).toBeInTheDocument();
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Connect/ })).not.toBeInTheDocument();
    await screen.findByLabelText('Runs: 4');
  });

  it('counts runs the way the list does: a subtask is never counted on its own', async () => {
    const run = (key: string, overrides: Partial<ReturnType<typeof runSummary>>) => ({
      ...runSummary(),
      key,
      name: key,
      title: key,
      ...overrides,
    });
    const runs = [
      run('working', { state: 'running', status: 'running' }),
      run('idle-1', { state: 'waiting', status: 'waiting' }),
      run('idle-2', { state: 'waiting', status: 'waiting' }),
      run('failed', { state: 'failed', status: 'failed' }),
      ...Array.from({ length: 190 }, (_, n) => run(`merged-${n}`, { state: 'merged', status: 'done' })),
      run('epic', { state: 'merged', status: 'done' }),
      run('epic-task', { state: 'waiting', status: 'waiting', parentKey: 'epic' }),
    ];
    renderPage();
    act(() => receive('runs', { runs }));

    expect(screen.getByText('4 active · 191 done · 195 runs')).toBeInTheDocument();
    await screen.findByLabelText('Runs: 4');
  });
});

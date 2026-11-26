import { act, render, screen } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { Shell } from '../features/shell';
import { listBacklogs } from '../lib/backlog-endpoints';
import { getDoneLately, getFlow, getReadiness, getStats, listRuns } from '../lib/endpoints';
import { receive } from '../test/fake-socket';
import { runSummary, statsView } from '../test/fixtures';
import { listRunsFrom, runsPage } from '../test/runs-page';
import { doneItemsOf } from '../test/overview-fixtures';
import { QueryWrapper } from '../test/query-wrapper';
import HomePage from './page';

vi.mock('../lib/endpoints', () => ({
  getReadiness: vi.fn(),
  getStats: vi.fn(),
  listRuns: vi.fn(),
  getFlow: vi.fn(),
  getDoneLately: vi.fn(),
}));
vi.mock('../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(getStats).mockResolvedValue(statsView());
  vi.mocked(listRuns).mockImplementation(listRunsFrom([]));
  vi.mocked(getFlow).mockReset();
  vi.mocked(getDoneLately).mockResolvedValue([]);
  vi.mocked(listBacklogs).mockResolvedValue([]);
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
    act(() => receive('runs', runsPage([], { part: 'active' })));
    expect(await screen.findByRole('link', { name: 'Connect GitHub or GitLab' })).toHaveAttribute(
      'href',
      '/connections',
    );
  });

  it('spells out the action of a failing check', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'fail', line: 'docker is not running', short: 'not running', action: 'start Docker' },
      ],
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
});

describe('HomePage run line', () => {
  beforeEach(() => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [], checkedAt: null });
  });

  it('shows a skeleton and no empty text or connect button until the runs are loaded', async () => {
    renderPage();

    expect(screen.getAllByTestId('number-placeholder')).not.toHaveLength(0);
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Connect / })).not.toBeInTheDocument();
    await screen.findByText('Merged');
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
    vi.mocked(listRuns).mockImplementation(listRunsFrom(runs));
    vi.mocked(getDoneLately).mockResolvedValue(doneItemsOf(runs));
    renderPage();
    act(() => receive('runs', runsPage(runs, { part: 'active' })));

    expect(await screen.findByText('working')).toBeInTheDocument();
    expect(screen.queryByText('epic-task')).not.toBeInTheDocument();
  });
});

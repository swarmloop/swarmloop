import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Shell } from '../../features/shell';
import { getStats } from '../../lib/endpoints';
import { receive } from '../../test/fake-socket';
import { runSummary, statsView } from '../../test/fixtures';
import { QueryWrapper } from '../../test/query-wrapper';
import { runsPage } from '../../test/runs-page';
import StatsPage from './page';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn(), getStats: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(getStats).mockReset();
  vi.mocked(getStats).mockResolvedValue(statsView());
});

function renderPage(): void {
  render(
    <Shell onNewRun={vi.fn()}>
      <StatsPage />
    </Shell>,
    { wrapper: QueryWrapper },
  );
}

describe('StatsPage', () => {
  it("shows today's statistics with their range control and charts", async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Stats' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Runs: 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument();
    expect(screen.getByText('Server stalls per day')).toBeInTheDocument();
  });

  it('anchors the returns chart as returns', async () => {
    renderPage();
    await screen.findByLabelText('Runs: 4');
    const anchor = document.getElementById('returns');
    expect(anchor).not.toBeNull();
    expect(within(anchor as HTMLElement).getByText('Why work came back')).toBeInTheDocument();
    expect(within(anchor as HTMLElement).queryByText('Server stalls per day')).not.toBeInTheDocument();
  });

  it('reloads the statistics when the live runs change', async () => {
    renderPage();
    await screen.findByLabelText('Runs: 4');
    act(() => receive('runs', runsPage([runSummary()], { part: 'active' })));
    await waitFor(() => expect(vi.mocked(getStats)).toHaveBeenCalledTimes(2));
    act(() => receive('runs', runsPage([{ ...runSummary(), status: 'done' }], { part: 'done' })));
    await waitFor(() => expect(vi.mocked(getStats)).toHaveBeenCalledTimes(3));
  });
});

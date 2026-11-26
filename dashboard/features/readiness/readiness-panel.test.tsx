import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { mediaWidth } from '../../test/viewport';
import { ReadinessPanel } from './readiness-panel';
import { ReadinessProvider } from './use-readiness';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn() }));

function renderPanel(): void {
  render(
    <ReadinessProvider>
      <ReadinessPanel />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

const CHECKED_AT = '2026-01-01T00:00:00.000Z';

describe('ReadinessPanel', () => {
  it('shows a tile per check and spells out what to do for one that fails', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'ok', line: 'docker answers', short: 'running', action: 'nothing to do' },
        { id: 'disk', status: 'fail', line: '2.0 GB free', short: '2.0 GB free', action: 'free some disk space' },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    expect(await screen.findByText(/2\.0 GB free/)).toHaveTextContent('free some disk space');
    expect(screen.getByText('A run cannot start yet')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 checks pass')).toBeInTheDocument();
    expect(screen.getByLabelText('Docker: ready, docker answers')).toHaveTextContent('running');
    expect(screen.queryByText(/nothing to do/)).not.toBeInTheDocument();
  });

  it('a readiness link opens its card', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        {
          id: 'model-credential',
          status: 'fail',
          line: 'no key for claude',
          short: 'missing',
          action: 'connect it',
          link: '/connections#claude',
        },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();

    expect(await screen.findByRole('link', { name: 'Open Connections' })).toHaveAttribute(
      'href',
      '/connections#claude',
    );
  });

  it("shows Docker's CPUs and memory on its tile", async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        {
          id: 'docker',
          status: 'ok',
          line: '8 CPUs · 15.6 GB, CHECKS_PARALLEL 4 asked',
          short: '8 CPUs · 15.6 GB',
          action: 'nothing to do',
        },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    expect(await screen.findByLabelText(/^Docker: ready/)).toHaveTextContent('8 CPUs · 15.6 GB');
  });

  it('shows the stall alert with its count, total and kind and a link to Statistics', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        {
          id: 'stalls',
          status: 'warn',
          line: 'The server stalled 2 times in the last hour, 32 s in all (server blocked)',
          short: '2 times in the last hour',
          action: 'give Docker more CPUs or memory',
          link: '/stats#statistics',
        },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    expect(
      await screen.findByText(/The server stalled 2 times in the last hour, 32 s in all \(server blocked\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Statistics' })).toHaveAttribute('href', '/stats#statistics');
  });

  it('shows no stall alert without the item', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', short: 'running', action: 'nothing to do' }],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    await screen.findByText('Ready to run');
    expect(screen.queryByText(/The server stalled/)).not.toBeInTheDocument();
  });

  it("lists the four parts of swarmloop's own disk use with sizes on the Disk tile", async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        {
          id: 'disk',
          status: 'ok',
          line: 'Disk text that is not cut by the dashboard',
          short: '19.7 GB free',
          ownUse: 'worktrees 1.2 GB, logs 3.0 MB, backups 500.0 MB, environment cache 0 B, measured 3 min ago',
          action: 'nothing to do',
        },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    const tile = await screen.findByLabelText(/^Disk: ready/);
    expect(tile).toHaveTextContent('19.7 GB free');
    expect(tile).toHaveTextContent(
      'worktrees 1.2 GB, logs 3.0 MB, backups 500.0 MB, environment cache 0 B, measured 3 min ago',
    );
    expect(tile).not.toHaveTextContent('not cut');
  });

  it('shows the short of each ok tile as the server sent it, never cut from the line', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        {
          id: 'model-credential',
          status: 'ok',
          line: 'A is set for claude; B is set for codex',
          short: 'claude · codex',
          action: 'nothing to do',
        },
        {
          id: 'ports',
          status: 'ok',
          line: 'API port 3920 is ours; dashboard port 3921 is free',
          short: '3920 · 3921',
          action: 'nothing to do',
        },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    expect(await screen.findByLabelText(/^Model key: ready/)).toHaveTextContent('claude · codex');
    expect(screen.getByLabelText(/^Ports: ready/)).toHaveTextContent('3920 · 3921');
  });

  it('says it is ready when every check passes', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', short: 'running', action: 'nothing to do' }],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    expect(await screen.findByText('Ready to run')).toBeInTheDocument();
  });

  it('shows the error text when the report cannot be read', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('api is down'));
    renderPanel();
    expect(await screen.findByText(/Readiness is not available: api is down/)).toBeInTheDocument();
  });
});

describe('ReadinessPanel refresh', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows placeholder tiles while the first report loads', () => {
    vi.mocked(getReadiness).mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(screen.getAllByTestId('readiness-placeholder')).toHaveLength(8);
    expect(screen.getByRole('region', { name: 'Readiness' })).toHaveAttribute('id', 'readiness');
  });

  it('says how old the report is', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', short: 'running', action: 'nothing to do' }],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('checked 30 s ago')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText(/^checked 1 min ago/)).toBeInTheDocument();
  });

  it('keeps the tiles and says quietly that a refresh failed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    vi.mocked(getReadiness).mockResolvedValueOnce({
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', short: 'running', action: 'nothing to do' }],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(screen.getByText('could not refresh, retrying')).toBeInTheDocument();
    expect(screen.getByLabelText('Docker: ready, docker answers')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the busy message, never HTTP 500, when no report came yet', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new ApiError(503, 'The server is busy, retrying', true));
    renderPanel();
    expect(await screen.findByText(/The server is busy, retrying/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument();
  });
});

describe.each([
  [375, 'minmax(0, 1fr)'],
  [1280, 'repeat(auto-fit, minmax(100px, 1fr))'],
])('ReadinessPanel at %i px', (width, columns) => {
  mediaWidth(width);

  it('lays the tiles out in the columns of its width, with the short text on one line', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', short: 'running', action: 'nothing to do' }],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    const tile = await screen.findByLabelText('Docker: ready, docker answers');
    expect(getComputedStyle(tile.parentElement as HTMLElement).gridTemplateColumns).toBe(columns);
    expect(screen.getByText('running')).toHaveClass('MuiTypography-noWrap');
  });

  it('lays the loading tiles out the same way', async () => {
    vi.mocked(getReadiness).mockReturnValue(new Promise(() => undefined));
    renderPanel();
    const [placeholder] = await screen.findAllByTestId('readiness-placeholder');
    expect(getComputedStyle(placeholder.parentElement as HTMLElement).gridTemplateColumns).toBe(columns);
  });
});

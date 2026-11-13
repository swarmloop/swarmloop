import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadinessItem } from '@contract/readiness';
import { ApiError } from '../../lib/api';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { ReadinessPanel, shortLine } from './readiness-panel';
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
        { id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' },
        { id: 'disk', status: 'fail', line: '2.0 GB free', action: 'free some disk space' },
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

  it("lists the four parts of swarmloop's own disk use with sizes on the Disk tile", async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        {
          id: 'disk',
          status: 'ok',
          line: '19.7 GB free, a step needs 10 GB (MIN_FREE_GB); swarmloop uses worktrees 1.2 GB, logs 3.0 MB, backups 500.0 MB, environment cache 0 B',
          action: 'nothing to do',
        },
      ],
      checkedAt: CHECKED_AT,
    });
    renderPanel();
    const tile = await screen.findByLabelText(/^Disk: ready/);
    expect(tile).toHaveTextContent('19.7 GB free');
    expect(tile).toHaveTextContent('worktrees 1.2 GB, logs 3.0 MB, backups 500.0 MB, environment cache 0 B');
  });

  it('says it is ready when every check passes', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' }],
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

describe('shortLine', () => {
  const item = (id: ReadinessItem['id'], line: string): ReadinessItem => ({ id, status: 'ok', line, action: '' });

  it('keeps the few words that matter', () => {
    expect(shortLine(item('disk', '19.7 GB free, a step needs 10 GB (MIN_FREE_GB)'))).toBe('19.7 GB free');
    expect(shortLine(item('images', 'a is present; b is present'))).toBe('2 present');
    expect(shortLine(item('ports', 'API port 3920 is ours; dashboard port 3921 is free'))).toBe('3920 · 3921');
    expect(shortLine(item('model-credential', 'CLAUDE_CODE_OAUTH_TOKEN is set for claude'))).toBe('claude');
    expect(shortLine(item('code-host-token', 'GITHUB_TOKEN is accepted'))).toBe('github');
    expect(shortLine(item('arch', 'arm64 is supported'))).toBe('arm64');
  });
});

describe('ReadinessPanel refresh', () => {
  afterEach(() => {
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
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' }],
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
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' }],
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

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadinessItem } from '@contract/readiness';
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
      load: null,
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
      load: null,
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
      load: null,
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

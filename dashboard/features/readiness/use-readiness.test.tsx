import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadinessItem } from '@contract/readiness';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { ReadinessProvider, useReadiness } from './use-readiness';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn() }));

const item = (id: ReadinessItem['id'], status: ReadinessItem['status']): ReadinessItem => ({
  id,
  status,
  line: `${id} line`,
  action: `${id} action`,
});

function Probe() {
  const { items, blocker, error } = useReadiness();
  return (
    <div>
      <p>items: {items.length}</p>
      <p>blocker: {blocker?.id ?? 'none'}</p>
      {error ? <p>error: {error}</p> : null}
    </div>
  );
}

function renderProbe(): void {
  render(
    <ReadinessProvider>
      <Probe />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

const CHECKED_AT = '2026-01-01T00:00:00.000Z';

describe('useReadiness', () => {
  it('blocks on the first fail item', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [item('docker', 'ok'), item('disk', 'fail'), item('paths', 'fail')],
      checkedAt: CHECKED_AT,
      load: null,
    });
    renderProbe();
    expect(await screen.findByText('blocker: disk')).toBeInTheDocument();
    expect(screen.getByText('items: 3')).toBeInTheDocument();
  });

  it('does not block on warn items', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [item('images', 'warn'), item('docker', 'ok')],
      checkedAt: CHECKED_AT,
      load: null,
    });
    renderProbe();
    expect(await screen.findByText('items: 2')).toBeInTheDocument();
    expect(screen.getByText('blocker: none')).toBeInTheDocument();
  });

  it('does not block when the report cannot be read, and gives the error text', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    renderProbe();
    expect(await screen.findByText('error: boom')).toBeInTheDocument();
    expect(screen.getByText('blocker: none')).toBeInTheDocument();
  });
});

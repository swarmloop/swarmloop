import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadinessItem } from '@contract/readiness';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { ReadinessLine } from './readiness-line';
import { ReadinessProvider } from './use-readiness';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn() }));

const CHECKED_AT = '2026-01-01T00:00:00.000Z';

function renderLine(): void {
  render(
    <ReadinessProvider>
      <ReadinessLine />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

function item(status: ReadinessItem['status'], line: string): ReadinessItem {
  return { id: 'docker', status, line, action: 'start Docker' };
}

describe('ReadinessLine', () => {
  it('shows a placeholder while the report loads', () => {
    vi.mocked(getReadiness).mockReturnValue(new Promise(() => undefined));
    renderLine();
    expect(screen.getByLabelText('Loading readiness')).toBeInTheDocument();
    expect(screen.queryByText('Everything is ready')).not.toBeInTheDocument();
  });

  it('reads Everything is ready when every item is ok', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [item('ok', 'docker answers')], checkedAt: CHECKED_AT });
    renderLine();
    expect(await screen.findByText('Everything is ready')).toBeInTheDocument();
    expect(screen.queryByText('Docker')).not.toBeInTheDocument();
  });

  it('shows the panel when a check fails', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [item('ok', 'docker answers'), item('fail', 'docker is not running')],
      checkedAt: CHECKED_AT,
    });
    renderLine();
    expect(await screen.findByText(/docker is not running/)).toHaveTextContent('start Docker');
    expect(screen.queryByText('Everything is ready')).not.toBeInTheDocument();
  });

  it('shows the panel when a check warns', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [item('warn', 'docker is slow')], checkedAt: CHECKED_AT });
    renderLine();
    expect(await screen.findByText(/docker is slow/)).toBeInTheDocument();
    expect(screen.queryByText('Everything is ready')).not.toBeInTheDocument();
  });

  it('shows the panel with the reason when the report cannot be read', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    renderLine();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByText('Everything is ready')).not.toBeInTheDocument();
  });
});

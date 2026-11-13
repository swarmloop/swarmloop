import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type { MachineLoad, ReadinessItem } from '@contract/readiness';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { ReadinessStatus } from './readiness-status';
import { ReadinessProvider } from './use-readiness';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn() }));

const { palette } = createTheme();

const item = (id: ReadinessItem['id'], status: ReadinessItem['status']): ReadinessItem => ({
  id,
  status,
  line: `${id} line`,
  action: `${id} action`,
});

const LOAD: MachineLoad = {
  capacityCpus: 8,
  capacityMemoryBytes: 16e9,
  usedCpus: 2,
  usedMemoryBytes: 8e9,
  running: ['checks of run a'],
  waiting: ['checks of run b'],
};

function renderStatus(items: ReadinessItem[], load: MachineLoad | null): void {
  vi.mocked(getReadiness).mockResolvedValue({ items, checkedAt: '2026-01-01T00:00:00.000Z', load });
  render(
    <ReadinessProvider>
      <ReadinessStatus />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

describe('ReadinessStatus', () => {
  it.each([
    ['ok', [item('docker', 'ok')], 'Readiness: ready'],
    ['warn', [item('docker', 'ok'), item('images', 'warn')], 'Readiness: warning'],
    ['fail', [item('images', 'warn'), item('disk', 'fail')], 'Readiness: problem'],
  ] as const)('names the worst item for %s and links to the panel', async (_name, items, label) => {
    renderStatus([...items], null);
    const link = await screen.findByRole('link', { name: label });
    expect(link).toHaveAttribute('href', '/#readiness');
  });

  it.each([
    ['ok', [item('docker', 'ok')], palette.success.main],
    ['warn', [item('docker', 'ok'), item('images', 'warn')], palette.warning.main],
    ['fail', [item('images', 'warn'), item('disk', 'fail')], palette.error.main],
  ] as const)('colors the dot for %s in the color of the worst item', async (_name, items, color) => {
    renderStatus([...items], null);
    await screen.findByRole('link', { name: /Readiness: (ready|warning|problem)/ });
    expect(screen.getByTestId('readiness-dot')).toHaveStyle({ backgroundColor: color });
  });

  it('greys the dot while the first report loads', () => {
    vi.mocked(getReadiness).mockReturnValue(new Promise(() => undefined));
    render(
      <ReadinessProvider>
        <ReadinessStatus />
      </ReadinessProvider>,
      { wrapper: QueryWrapper },
    );
    expect(screen.getByTestId('readiness-dot')).toHaveStyle({ backgroundColor: palette.text.disabled });
  });

  it('greys the dot when the report has no items', async () => {
    renderStatus([], null);
    await screen.findByRole('link', { name: 'Readiness: checking' });
    expect(screen.getByTestId('readiness-dot')).toHaveStyle({ backgroundColor: palette.text.disabled });
  });

  it('draws the CPU and memory of heavy work against the budget', async () => {
    renderStatus([item('docker', 'ok')], LOAD);
    expect(await screen.findByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByRole('meter', { name: 'Memory' })).toHaveAttribute('aria-valuenow', '50');
  });

  it('draws no meters when no limit is known', async () => {
    renderStatus([item('docker', 'ok')], null);
    await screen.findByRole('link', { name: 'Readiness: ready' });
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('lists failing items, what runs and what waits in the tooltip', async () => {
    renderStatus([item('docker', 'ok'), item('disk', 'fail')], LOAD);
    await userEvent.hover(await screen.findByRole('link', { name: 'Readiness: problem' }));
    expect(await screen.findByText('Disk: disk line')).toBeInTheDocument();
    expect(screen.getByText('Running: checks of run a')).toBeInTheDocument();
    expect(screen.getByText('Waiting: checks of run b')).toBeInTheDocument();
  });
});

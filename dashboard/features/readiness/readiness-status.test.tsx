import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
const GB = 1024 ** 3;

const item = (id: ReadinessItem['id'], status: ReadinessItem['status']): ReadinessItem => ({
  id,
  status,
  line: `${id} line`,
  action: `${id} action`,
});

const LOAD: MachineLoad = {
  capacityMemoryBytes: 12 * GB,
  usedMemoryBytes: 9.1 * GB,
  running: ['checks of run a'],
  waiting: ['checks of run b', 'checks of run c', 'checks of run d', 'checks of run e'],
};
const IDLE: MachineLoad = { ...LOAD, waiting: [] };

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
  it('shows a setup problem with the error icon even while work waits, and links to the panel', async () => {
    renderStatus([item('docker', 'ok'), item('disk', 'fail')], LOAD);
    const link = await screen.findByRole('link', { name: '1 setup problem' });
    expect(link).toHaveAttribute('href', '/#readiness');
    expect(screen.getByTestId('ErrorIcon')).toHaveStyle({ color: palette.error.main });
    expect(screen.queryByText(/waiting for machine/)).not.toBeInTheDocument();
  });

  it('counts several setup problems', async () => {
    renderStatus([item('disk', 'fail'), item('images', 'fail')], IDLE);
    expect(await screen.findByRole('link', { name: '2 setup problems' })).toBeInTheDocument();
  });

  it('shows the work that waits for the machine with the hourglass', async () => {
    renderStatus([item('docker', 'ok')], LOAD);
    await screen.findByRole('link', { name: '4 waiting for machine' });
    expect(screen.getByTestId('HourglassEmptyIcon')).toHaveStyle({ color: palette.warning.main });
  });

  it('shows a setup warning with the warning icon when nothing waits', async () => {
    renderStatus([item('docker', 'ok'), item('images', 'warn')], IDLE);
    await screen.findByRole('link', { name: '1 setup warning' });
    expect(screen.getByTestId('WarningAmberIcon')).toHaveStyle({ color: palette.warning.main });
  });

  it('shows nothing when all is fine, and while the first report loads', async () => {
    renderStatus([item('docker', 'ok')], IDLE);
    await waitFor(() => expect(getReadiness).toHaveBeenCalled());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    cleanup();
    vi.mocked(getReadiness).mockReturnValue(new Promise(() => undefined));
    render(
      <ReadinessProvider>
        <ReadinessStatus />
      </ReadinessProvider>,
      { wrapper: QueryWrapper },
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByTestId('readiness-dot')).not.toBeInTheDocument();
  });

  it('lists the failing and warning items and the memory booked in the tooltip, with no run key', async () => {
    renderStatus([item('docker', 'ok'), item('disk', 'fail'), item('images', 'warn')], LOAD);
    await userEvent.hover(await screen.findByRole('link', { name: '1 setup problem' }));
    expect(await screen.findByText('Disk: disk line')).toBeInTheDocument();
    expect(screen.getByText('Images: images line')).toBeInTheDocument();
    expect(screen.getByText('Memory booked: 9.1 of 12 GB')).toBeInTheDocument();
    expect(screen.getByText('Waiting work starts when its memory fits.')).toBeInTheDocument();
    expect(screen.queryByText(/checks of run/)).not.toBeInTheDocument();
  });
});

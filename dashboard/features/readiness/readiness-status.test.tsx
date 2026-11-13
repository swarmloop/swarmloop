import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type { ReadinessItem } from '@contract/readiness';
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

function renderStatus(items: ReadinessItem[]): void {
  vi.mocked(getReadiness).mockResolvedValue({ items, checkedAt: '2026-01-01T00:00:00.000Z' });
  render(
    <ReadinessProvider>
      <ReadinessStatus />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

describe('ReadinessStatus', () => {
  it('shows a setup problem with the error icon and links to the panel', async () => {
    renderStatus([item('docker', 'ok'), item('disk', 'fail')]);
    const link = await screen.findByRole('link', { name: '1 setup problem' });
    expect(link).toHaveAttribute('href', '/#readiness');
    expect(screen.getByTestId('ErrorIcon')).toHaveStyle({ color: palette.error.main });
  });

  it('counts several setup problems', async () => {
    renderStatus([item('disk', 'fail'), item('images', 'fail')]);
    expect(await screen.findByRole('link', { name: '2 setup problems' })).toBeInTheDocument();
  });

  it('shows a setup warning with the warning icon', async () => {
    renderStatus([item('docker', 'ok'), item('images', 'warn')]);
    await screen.findByRole('link', { name: '1 setup warning' });
    expect(screen.getByTestId('WarningAmberIcon')).toHaveStyle({ color: palette.warning.main });
    expect(screen.queryByText(/waiting for machine/)).not.toBeInTheDocument();
  });

  it('shows nothing when all is fine, and while the first report loads', async () => {
    renderStatus([item('docker', 'ok')]);
    await waitFor(() => expect(getReadiness).toHaveBeenCalled());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for machine/)).not.toBeInTheDocument();
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

  it('lists the failing and warning items in the tooltip, with no run key', async () => {
    renderStatus([item('docker', 'ok'), item('disk', 'fail'), item('images', 'warn')]);
    await userEvent.hover(await screen.findByRole('link', { name: '1 setup problem' }));
    expect(await screen.findByText('Disk: disk line')).toBeInTheDocument();
    expect(screen.getByText('Images: images line')).toBeInTheDocument();
    expect(screen.queryByText(/Memory booked|Waiting work/)).not.toBeInTheDocument();
    expect(screen.queryByText(/checks of run/)).not.toBeInTheDocument();
  });
});

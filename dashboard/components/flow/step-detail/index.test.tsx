import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveBridgeProvider } from '../../../hooks/use-live-bridge';
import { getStep } from '../../../lib/endpoints';
import { stepView } from '../../../test/fixtures';
import { StepDetail } from './index';

vi.mock('../../../lib/endpoints', () => ({ getStep: vi.fn(), getRunLog: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function detail(overrides: Partial<ComponentProps<typeof StepDetail>> = {}) {
  render(
    <StepDetail
      runKey="run-1"
      step="implement"
      live={false}
      revision="2026-01-01T00:00:00.000Z"
      now={0}
      attempts={0}
      {...overrides}
    />,
    { wrapper: LiveBridgeProvider },
  );
}

beforeEach(() => {
  vi.mocked(getStep).mockResolvedValue(stepView());
});

describe('StepDetail', () => {
  it('shows the step label once the step loads', async () => {
    detail();

    expect(await screen.findByText('implement')).toBeInTheDocument();
  });

  it('shows the load error text', async () => {
    vi.mocked(getStep).mockRejectedValue(new Error('step is gone'));

    detail();

    expect(await screen.findByText('step is gone')).toBeInTheDocument();
  });

  it('calls onReplay from Run again', async () => {
    const user = userEvent.setup();
    const onReplay = vi.fn();
    detail({ onReplay });

    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('shows Resume only when onResume is passed', async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    detail({ onResume });

    await user.click(await screen.findByRole('button', { name: 'Resume' }));

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('hides Resume without onResume', async () => {
    detail();

    await screen.findByText('implement');
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });
});

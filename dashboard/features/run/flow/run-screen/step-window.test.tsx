import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunLog, getStep, getStepEvents } from '../../../../lib/endpoints';
import { LiveBridgeProvider } from '../../../shell';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { flowView, stepView, visitView } from '../../../../test/fixtures';
import { StepWindow } from './step-window';

vi.mock('../../../../lib/endpoints', () => ({ getStep: vi.fn(), getStepEvents: vi.fn(), getRunLog: vi.fn() }));
vi.mock('../../../../lib/live', async () => (await import('../../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

function window(step: string, status: string, visitStatus: string, actions = ['replay']) {
  const onReplay = vi.fn();
  vi.mocked(getStep).mockResolvedValue(
    stepView({ step, descriptor: { name: step, kind: 'agent' }, visits: [visitView({ status: visitStatus })] }),
  );
  render(
    <StepWindow
      flow={{ ...flowView({ status }), actions } as ReturnType<typeof flowView>}
      step={step}
      attempts={1}
      now={0}
      onReplay={onReplay}
      onResume={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
  return onReplay;
}

beforeEach(() => {
  vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
  vi.mocked(getRunLog).mockResolvedValue({ text: '', bytes: 0 } as never);
});

describe('StepWindow', () => {
  it('offers neither Run again nor Retry on a finished reviewer step', async () => {
    window('code-review-quality', 'done', 'done');

    expect(await screen.findByText('quality')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('replays a finished step from Run again', async () => {
    const user = userEvent.setup({ delay: null });
    const onReplay = window('implement', 'done', 'done');

    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    expect(onReplay).toHaveBeenCalledWith('implement');
  });

  it('shows Retry on a failed step', async () => {
    window('implement', 'failed', 'failed');

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('reads a step whose chip is idle as not started, with its old visit kept', async () => {
    vi.mocked(getStep).mockResolvedValue(
      stepView({
        step: 'checks',
        descriptor: { name: 'checks', kind: 'agent' },
        visits: [visitView({ status: 'done' })],
      }),
    );
    const flow = flowView({
      status: 'running',
      currentStep: 'checks',
      phases: [{ phase: 'checks', steps: [{ name: 'checks', status: 'idle', current: false, attempts: 1 }] }],
    });
    render(<StepWindow flow={flow} step="checks" attempts={1} now={0} onReplay={vi.fn()} onResume={vi.fn()} />, {
      wrapper: Wrapper,
    });

    expect(await screen.findByText('Not started')).toBeInTheDocument();
    expect(screen.queryByText('done')).toBeNull();
  });

  it('offers no replay while the run is running', async () => {
    window('implement', 'running', 'done');

    expect(await screen.findByText('implement')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });
});

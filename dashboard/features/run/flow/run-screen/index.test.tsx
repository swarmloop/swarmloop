import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlow, getStep, getStepEvents, listProjects } from '../../../../lib/endpoints';
import { LiveBridgeProvider } from '../../../shell';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { flowView, stepView } from '../../../../test/fixtures';
import { RunScreen } from './index';

vi.mock('../../../../lib/endpoints', () => ({
  getFlow: vi.fn(),
  getStep: vi.fn(),
  getStepEvents: vi.fn(),
  getRunLog: vi.fn(),
  listProjects: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  sendAnswers: vi.fn(),
  resumeRun: vi.fn(),
  stopRun: vi.fn(),
  rebaseRun: vi.fn(),
  startReviewer: vi.fn(),
  replayStep: vi.fn(),
}));
vi.mock('../../../../lib/live', async () => (await import('../../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

beforeEach(() => {
  vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
  vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done' }));
  vi.mocked(getStep).mockResolvedValue(stepView());
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
});

describe('RunScreen', () => {
  it('says at the top of the page that the run waits for a provider limit', async () => {
    const limit = { runtime: 'claude', resetsAt: '2026-11-08T21:50:00.000Z', resumesAt: '2026-11-08T21:51:00.000Z' };
    vi.mocked(getFlow).mockResolvedValue(
      flowView({
        status: 'waiting',
        state: 'waiting',
        stateReason: { code: 'RUNTIME_LIMIT', message: 'Claude hit its usage limit.', limit },
      }),
    );
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    expect(
      await screen.findByText(/^Claude hit its usage limit \(resets \d\d:\d\d\)\. The run goes on at \d\d:\d\d\.$/),
    ).toBeInTheDocument();
  });

  it('links a subtask page to its parent run', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ parentKey: 'p-1' }));
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    expect(await screen.findByRole('link', { name: 'p-1' })).toHaveAttribute('href', '/runs/p-1');
  });

  it('shows tasks after plan-improve', async () => {
    const tasks = [
      { layer: 0, tasks: [{ id: 'a', title: 'Add the column', files: ['a.ts'], proof: 'a.spec.ts' }] },
      { layer: 1, tasks: [{ id: 'b', title: 'Send it', files: ['b.ts', 'c.ts'], proof: 'b.spec.ts' }] },
    ];
    vi.mocked(getFlow).mockResolvedValue(flowView({ tasks }));
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    const region = await screen.findByRole('region', { name: 'Tasks' });
    expect(region).toHaveTextContent('Layer 1');
    expect(region).toHaveTextContent('Add the column');
    expect(region).toHaveTextContent('files: b.ts, c.ts · proof: b.spec.ts');
  });

  it('no block without subtasks', async () => {
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });
    await screen.findByRole('heading', { name: 'Run one' });

    expect(screen.queryByRole('region', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  it('shows no parent link on a run without a parent', async () => {
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });
    await screen.findByRole('heading', { name: 'Run one' });

    expect(screen.queryByText(/Subtask of/)).not.toBeInTheDocument();
  });

  it('lets the main column shrink so the page never scrolls sideways', async () => {
    const { container } = render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });
    await screen.findByRole('heading', { name: 'Run one' });

    expect(container.firstElementChild).toHaveStyle({ minWidth: '0' });
  });

  it('shows Loading the run. until the flow loads, then the flow name and board', async () => {
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    expect(screen.getByText('Loading the run.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Run one' })).toBeInTheDocument();
    expect(screen.getByText('implementation')).toBeInTheDocument();
  });

  it('opens the run dialog titled with the step on Run again', async () => {
    const user = userEvent.setup();
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'implement' })).toBeInTheDocument();
  });
});

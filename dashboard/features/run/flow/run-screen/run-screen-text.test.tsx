import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlow, getStep, getStepEvents, listProjects, listRemote, getSession } from '../../../../lib/endpoints';
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
  listRemote: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  getSession: vi.fn(),
  resumeRun: vi.fn(),
  stopRun: vi.fn(),
  rebaseRun: vi.fn(),
  skipTask: vi.fn(),
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

const launches = [
  {
    phases: ['requirements', 'planning', 'implementation', 'code review', 'ci'],
    fromStep: null,
    createdAt: '2026-11-08T10:00:00.000Z',
  },
];
const metrics = { ...flowView().metrics, cpuPeak: 679, memPeak: 4107.3 * 1024 * 1024 };

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ user: 'alice' });
  vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
  vi.mocked(getStep).mockResolvedValue(stepView());
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(listRemote).mockResolvedValue({
    repositories: [],
    owners: [],
    reason: null,
    allowedNames: [],
    loading: false,
    error: null,
  });
});

describe('the run screen text', () => {
  it('shows no mode name, flow chip, percent CPU or total label on a finished run', async () => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done', state: 'done', launches, metrics }));
    const { container } = render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    await screen.findByRole('region', { name: 'Summary' });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d\s*%/);
    expect(text).not.toMatch(/\bcpu\b|\bmem\b/i);
    expect(text).not.toMatch(/\btotal\b|this run/);
    expect(screen.queryByText('planning')).not.toBeInTheDocument();
    expect(screen.queryByText('server')).not.toBeInTheDocument();
    expect(screen.queryByText('agent')).not.toBeInTheDocument();
  });

  it.each([
    ['running', { status: 'running', state: 'running' }],
    ['waiting', { status: 'waiting', state: 'waiting' }],
  ] as const)('shows no flow chip or total label above the board of a %s run', async (_name, overrides) => {
    vi.mocked(getFlow).mockResolvedValue(flowView({ ...overrides, launches, metrics }));
    const { container } = render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    await screen.findByRole('heading', { name: 'Run one' });
    await waitFor(() => expect(getStep).toHaveBeenCalled());
    await screen.findByText(/\d+ in$/);
    expect(container.textContent).not.toMatch(/\d\s*%|\bcpu\b|\bmem\b/i);
    expect(container.textContent).not.toMatch(/\btotal\b|this run/);
    expect(screen.queryByText('planning')).not.toBeInTheDocument();
    expect(screen.queryByText('code review')).not.toBeInTheDocument();
  });
});

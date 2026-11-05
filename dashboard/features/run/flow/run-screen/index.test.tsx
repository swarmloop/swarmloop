import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlow, getStep, listProjects } from '../../../../lib/endpoints';
import { LiveBridgeProvider } from '../../../shell';
import { flowView, stepView } from '../../../../test/fixtures';
import { RunScreen } from './index';

vi.mock('../../../../lib/endpoints', () => ({
  getFlow: vi.fn(),
  getStep: vi.fn(),
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

beforeEach(() => {
  vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done' }));
  vi.mocked(getStep).mockResolvedValue(stepView());
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
});

describe('RunScreen', () => {
  it('shows Loading the run. until the flow loads, then the flow name and board', async () => {
    render(<RunScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(screen.getByText('Loading the run.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Run one' })).toBeInTheDocument();
    expect(screen.getByText('implementation')).toBeInTheDocument();
  });

  it('opens the run dialog titled with the step on Run again', async () => {
    const user = userEvent.setup();
    render(<RunScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });

    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'implement' })).toBeInTheDocument();
  });
});

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { listRuns } from '../../lib/endpoints';
import { activeMilestoneBacklog } from '../../test/backlog-fixtures';
import { epicRun, milestoneRun, questionRun, subtaskRun, workingRun } from '../../test/overview-fixtures';
import { listRunsFrom } from '../../test/runs-page';
import { NowSection } from './index';
import { PartsWrapper } from './test-wrapper.spec-helpers';

vi.mock('../../lib/endpoints', () => ({ listRuns: vi.fn(), getFlow: vi.fn() }));
vi.mock('../../lib/backlog-endpoints', () => ({ listBacklogs: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

function load(runs: Parameters<typeof listRunsFrom>[0], backlogs: Awaited<ReturnType<typeof listBacklogs>> = []): void {
  vi.mocked(listRuns).mockImplementation(listRunsFrom(runs));
  vi.mocked(listBacklogs).mockResolvedValue(backlogs);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NowSection', () => {
  it('shows an active milestone with merged out of all its tasks', async () => {
    load([], [activeMilestoneBacklog('shop')]);
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(await screen.findByText('4/6 tasks')).toBeInTheDocument();
    expect(screen.getByText('Checkout').closest('a')).toHaveAttribute('href', '/backlogs/shop');
  });

  it('shows a run with its step in words, its state word and its ETA', async () => {
    load([workingRun('run-a', { currentStep: 'implement' })]);
    render(<NowSection />, { wrapper: PartsWrapper });
    const card = (await screen.findByText('Title of run-a')).closest('a');
    expect(card).toHaveAttribute('href', '/runs/run-a');
    expect(within(card as HTMLElement).getByText('implementation')).toBeInTheDocument();
    expect(within(card as HTMLElement).getAllByText('Working')[0]).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('~5m left')).toBeInTheDocument();
  });

  it('shows an epic with its tasks', async () => {
    load([epicRun('epic-1', { taskCounts: { merged: 2, running: 1 } })]);
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(await screen.findByText('2/3 tasks')).toBeInTheDocument();
  });

  it('shows six cards of eight working items', async () => {
    load(Array.from({ length: 8 }, (_, index) => workingRun(`run-${index}`)));
    render(<NowSection />, { wrapper: PartsWrapper });
    await screen.findByText('Title of run-0');
    expect(screen.getAllByText(/^Title of run-/)).toHaveLength(6);
  });

  it('never shows a subtask or a milestone-held run on its own', async () => {
    load([epicRun('epic-1'), subtaskRun('sub-1', 'epic-1'), milestoneRun('held-1', 'shop')]);
    render(<NowSection />, { wrapper: PartsWrapper });
    await screen.findByText('Title of epic-1');
    expect(screen.queryByText('Title of sub-1')).not.toBeInTheDocument();
    expect(screen.queryByText('Title of held-1')).not.toBeInTheDocument();
  });

  it('links to the run list and says nothing runs when nothing works', async () => {
    load([questionRun('ask-1')]);
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(await screen.findByText('Nothing running')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '/');
  });

  it('shows placeholders before the first load', () => {
    load([]);
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(screen.getAllByTestId('now-placeholder')).not.toHaveLength(0);
    expect(screen.queryByText('Nothing running')).not.toBeInTheDocument();
  });
});

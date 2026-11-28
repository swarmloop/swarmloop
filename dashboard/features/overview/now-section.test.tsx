import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { listRuns } from '../../lib/endpoints';
import { activeMilestoneBacklog, backlogView, milestone, task } from '../../test/backlog-fixtures';
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

  it('shows a working backlog run outside a milestone', async () => {
    load([workingRun('loose', { backlog: { name: 'shop', milestone: null } })]);
    render(<NowSection />, { wrapper: PartsWrapper });
    expect((await screen.findByText('Title of loose')).closest('a')).toHaveAttribute('href', '/runs/loose');
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

  it('shows a progress bar for the step of a run, further along at a later step', async () => {
    load([workingRun('early', { currentStep: 'plan' }), workingRun('late', { currentStep: 'pipeline' })]);
    render(<NowSection />, { wrapper: PartsWrapper });
    const early = (await screen.findByText('Title of early')).closest('a') as HTMLElement;
    const late = screen.getByText('Title of late').closest('a') as HTMLElement;
    expect(within(early).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
    expect(within(late).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  const milestoneOf = (tasks: ReturnType<typeof task>[]) =>
    backlogView({ name: 'shop', milestones: [milestone({ status: 'active' })], tasks });

  it('shows the latest estimate of the unfinished tasks of a milestone', async () => {
    load(
      [
        workingRun('run-a', { eta: { leftMs: 10 * 60_000, doneAt: '2026-01-01T00:10:00.000Z' } }),
        workingRun('run-b', { eta: { leftMs: 60 * 60_000, doneAt: '2026-01-01T01:00:00.000Z' } }),
      ],
      [
        milestoneOf([
          task({ slug: 'a', runKey: 'run-a' }),
          task({ slug: 'b', runKey: 'run-b' }),
          task({ slug: 'c', status: 'merged', runKey: null }),
        ]),
      ],
    );
    render(<NowSection />, { wrapper: PartsWrapper });
    const card = (await screen.findByText('Checkout')).closest('a') as HTMLElement;
    expect(within(card).getByText('~1h left')).toBeInTheDocument();
  });

  it('shows no estimate for a milestone while a task waits for another or has no estimate', async () => {
    load(
      [workingRun('run-a')],
      [
        milestoneOf([
          task({ slug: 'a', runKey: 'run-a' }),
          task({ slug: 'b', status: 'waiting', depends: ['a'], runKey: null }),
        ]),
      ],
    );
    render(<NowSection />, { wrapper: PartsWrapper });
    const card = (await screen.findByText('Checkout')).closest('a') as HTMLElement;
    expect(within(card).getByText('no estimate yet')).toBeInTheDocument();
    expect(within(card).queryByText(/left/)).not.toBeInTheDocument();
  });

  it('counts a skipped task of a milestone as done', async () => {
    load(
      [],
      [
        milestoneOf([
          task({ slug: 'a', status: 'merged' }),
          task({ slug: 'b', status: 'skipped' }),
          task({ slug: 'c' }),
        ]),
      ],
    );
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(await screen.findByText('2/3 tasks')).toBeInTheDocument();
  });

  it('counts a skipped subtask of an epic as done', async () => {
    load([epicRun('epic-1', { taskCounts: { merged: 1, skipped: 1, running: 1 } })]);
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(await screen.findByText('2/3 tasks')).toBeInTheDocument();
  });

  it('says a milestone whose work is done waits for acceptance, not Working', async () => {
    const done = backlogView({
      name: 'shop',
      milestones: [milestone({ status: 'active' })],
      requirements: [],
      tasks: [task({ slug: 'a', status: 'merged' }), task({ slug: 'b', status: 'skipped' })],
    });
    load([], [done]);
    render(<NowSection />, { wrapper: PartsWrapper });
    const card = (await screen.findByText('Checkout')).closest('a') as HTMLElement;
    expect(within(card).getByText('Waiting for acceptance')).toBeInTheDocument();
    expect(within(card).queryByText('Working')).not.toBeInTheDocument();
  });

  it('says when the runs cannot be read', async () => {
    vi.mocked(listBacklogs).mockResolvedValue([]);
    vi.mocked(listRuns).mockRejectedValue(new Error('down'));
    render(<NowSection />, { wrapper: PartsWrapper });
    expect(await screen.findByText('Could not load what runs now.')).toBeInTheDocument();
  });
});

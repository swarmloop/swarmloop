import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { listRuns } from '../../lib/endpoints';
import { proposedMilestoneBacklog } from '../../test/backlog-fixtures';
import { failedRun, questionRun, subtaskRun } from '../../test/overview-fixtures';
import { ERROR_CODES } from '@contract/error-codes';
import { listRunsFrom } from '../../test/runs-page';
import { NeedsYou } from './index';
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
});

describe('NeedsYou', () => {
  it('shows a waiting question with its Answer button to the run', async () => {
    load([questionRun('ask-1')]);
    render(<NeedsYou />, { wrapper: PartsWrapper });
    const button = await screen.findByRole('link', { name: 'Answer' });
    expect(button).toHaveAttribute('href', '/runs/ask-1');
    expect(screen.getByText('Title of ask-1')).toBeInTheDocument();
  });

  it('shows a failure with its Resume button', async () => {
    load([failedRun('bad-1')]);
    render(<NeedsYou />, { wrapper: PartsWrapper });
    expect(await screen.findByRole('link', { name: 'Resume' })).toHaveAttribute('href', '/runs/bad-1');
    expect(screen.queryByRole('link', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('shows a run waiting on a git sign-in problem with its Resume button to the run', async () => {
    load([questionRun('auth', { stateReason: { code: ERROR_CODES.GIT_AUTH, message: 'git sign-in failed' } })]);
    render(<NeedsYou />, { wrapper: PartsWrapper });
    expect(await screen.findByRole('link', { name: 'Resume' })).toHaveAttribute('href', '/runs/auth');
    expect(screen.getAllByText('Title of auth')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('shows a proposed milestone with its Open button to the backlog', async () => {
    load([], [proposedMilestoneBacklog('shop')]);
    render(<NeedsYou />, { wrapper: PartsWrapper });
    expect(await screen.findByRole('link', { name: 'Open' })).toHaveAttribute('href', '/backlogs/shop');
  });

  it('shows three cards in order and `+1 more` to the run list for the rest', async () => {
    load([questionRun('ask-1'), failedRun('bad-1'), failedRun('bad-2')], [proposedMilestoneBacklog('shop')]);
    render(<NeedsYou />, { wrapper: PartsWrapper });
    await screen.findByText('+1 more');
    const buttons = screen
      .getAllByRole('link')
      .filter((link) => ['Answer', 'Resume', 'Open'].includes(link.textContent ?? ''));
    expect(buttons.map((button) => button.textContent)).toEqual(['Answer', 'Resume', 'Resume']);
    expect(screen.getByText('+1 more')).toHaveAttribute('href', '/');
  });

  it('never shows a subtask on its own', async () => {
    load([failedRun('epic-1'), subtaskRun('sub-1', 'epic-1', { state: 'failed', status: 'failed' })]);
    render(<NeedsYou />, { wrapper: PartsWrapper });
    const region = await screen.findByRole('region', { name: 'Needs you' });
    await screen.findByRole('link', { name: 'Resume' });
    expect(within(region).getAllByRole('link', { name: 'Resume' })).toHaveLength(1);
  });

  it('renders nothing when nobody is needed', async () => {
    load([]);
    const { container } = render(<NeedsYou />, { wrapper: PartsWrapper });
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows placeholders on the first paint and a line when the runs cannot be read', async () => {
    load([]);
    vi.mocked(listRuns).mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<NeedsYou />, { wrapper: PartsWrapper });
    expect(screen.getAllByTestId('needs-placeholder')).not.toHaveLength(0);
    unmount();
    vi.mocked(listRuns).mockRejectedValue(new Error('down'));
    render(<NeedsYou />, { wrapper: PartsWrapper });
    expect(await screen.findByText('Could not load what needs you.')).toBeInTheDocument();
  });

  it('keeps the placeholders until the backlogs arrive', () => {
    load([questionRun('ask-1')]);
    vi.mocked(listBacklogs).mockReturnValue(new Promise(() => undefined));
    render(<NeedsYou />, { wrapper: PartsWrapper });
    expect(screen.getAllByTestId('needs-placeholder')).not.toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Answer' })).not.toBeInTheDocument();
  });
});

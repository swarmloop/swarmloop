import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBacklog, runMilestone } from '../../../lib/backlog-endpoints';
import { backlogChatView, backlogView, milestone, requirement, task } from '../../../test/backlog-fixtures';
import { BacklogSections } from './backlog-sections';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('../../../lib/backlog-endpoints', () => ({
  runBacklog: vi.fn(),
  runMilestone: vi.fn(),
  mergeBacklogTask: vi.fn(),
}));

const view = backlogView({
  milestones: [
    milestone(),
    milestone({ number: 4, title: 'Shipping', goal: 'Parcels leave', status: 'proposed' }),
    milestone({ number: 5, title: 'Returns', goal: 'Parcels return', status: 'queued' }),
  ],
  requirements: [requirement({ ref: 'M4.R1', milestone: 4, text: 'Label printed', status: 'open' })],
  tasks: [
    task({ slug: 'print', title: 'Print label', milestone: 4, status: 'waiting' }),
    task({ slug: 'idea', title: 'Loose idea', milestone: null, status: 'waiting' }),
  ],
  decisions: [{ text: 'Use cards only', who: 'ada', at: '2026-01-01T10:00:00.000Z' }],
});

function sections(login: string | null, shown = view): void {
  render(<BacklogSections view={shown} chat={backlogChatView()} login={login} onView={vi.fn()} onChat={vi.fn()} />);
}

beforeEach(() => {
  vi.mocked(runBacklog).mockReset();
  vi.mocked(runMilestone).mockReset();
});

describe('BacklogSections', () => {
  it('folds planned milestones, backlog items and decisions under their counts', async () => {
    sections('ada');

    expect(screen.getByRole('button', { name: 'Planned milestones (2)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Loose idea')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Backlog items (1)' }));
    expect(screen.getByText('Loose idea')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Decisions (1)' }));
    expect(screen.getByText('Use cards only')).toBeInTheDocument();
    expect(screen.getByText(/^ada · /)).toBeInTheDocument();
  });

  it('unfolds a milestone in place', async () => {
    sections('ada');

    await userEvent.click(screen.getByRole('button', { name: 'Planned milestones (2)' }));
    await userEvent.click(screen.getByRole('button', { name: 'M4 · Shipping' }));

    expect(screen.getByText('Parcels leave')).toBeInTheDocument();
    expect(screen.getByText('Label printed')).toBeInTheDocument();
    expect(screen.getByText('Print label')).toBeInTheDocument();
  });

  it('starts a proposed milestone and the whole backlog for the owner', async () => {
    vi.mocked(runMilestone).mockResolvedValue(view);
    vi.mocked(runBacklog).mockResolvedValue(view);
    sections('ada');

    await userEvent.click(screen.getByRole('button', { name: 'Planned milestones (2)' }));
    expect(screen.getAllByRole('button', { name: 'Run milestone' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Run milestone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run backlog' }));

    expect(runMilestone).toHaveBeenCalledWith('swarmloop', 4);
    expect(runBacklog).toHaveBeenCalledWith('swarmloop');
  });

  it('shows no start buttons to anyone else or without a proposal', () => {
    sections('grace');
    expect(screen.queryByRole('button', { name: 'Run backlog' })).not.toBeInTheDocument();
  });

  it('hides Run backlog when no milestone is proposed', () => {
    sections('ada', backlogView());

    expect(screen.queryByRole('button', { name: 'Run backlog' })).not.toBeInTheDocument();
  });

  it('shows a refusal', async () => {
    vi.mocked(runBacklog).mockRejectedValue(new Error('Already running'));
    sections('ada');

    await userEvent.click(screen.getByRole('button', { name: 'Run backlog' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already running');
  });
});

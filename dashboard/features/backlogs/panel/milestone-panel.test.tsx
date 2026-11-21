import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeBacklogTask } from '../../../lib/backlog-endpoints';
import { backlogChatView, backlogView, requirement, task } from '../../../test/backlog-fixtures';
import { MilestonePanel } from './milestone-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('../../../lib/backlog-endpoints', () => ({ mergeBacklogTask: vi.fn() }));

const view = backlogView({
  requirements: [
    requirement({ ref: 'M3.R1', text: 'Open one', status: 'open' }),
    requirement({ ref: 'M3.R2', text: 'Ready one', status: 'ready' }),
    requirement({ ref: 'M3.R3', text: 'Closed by task', status: 'closed', closedBy: ['pay'] }),
    requirement({ ref: 'M3.R4', text: 'Closed alone', status: 'closed', closedBy: [] }),
  ],
  tasks: [
    task({ slug: 'pay', title: 'Pay by card', note: 'Waits for review', runKey: 'run-1', waitsForOk: true }),
    task({ slug: 'other', title: 'Other task', waitsForOk: false }),
  ],
});

function panel(login: string | null, onView = vi.fn()): void {
  render(<MilestonePanel view={view} chat={backlogChatView()} login={login} onView={onView} onChat={vi.fn()} />);
}

beforeEach(() => vi.mocked(mergeBacklogTask).mockReset());

describe('MilestonePanel', () => {
  it('shows the milestone heading and the marks with what closed each requirement', () => {
    panel('ada');

    expect(screen.getByRole('heading', { name: 'M3 · Checkout' })).toBeInTheDocument();
    expect(screen.getByText(/^open$/)).toBeInTheDocument();
    expect(screen.getByText(/^ready$/)).toBeInTheDocument();
    expect(screen.getByText(/closed · closed by Pay by card/)).toBeInTheDocument();
    expect(screen.getByText(/closed · closed by hand/)).toBeInTheDocument();
  });

  it('shows task rows with the note and a link to the run', () => {
    panel('ada');

    expect(screen.getByText('Waits for review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open run Pay by card' })).toHaveAttribute('href', '/runs/run-1');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('shows Merge to the owner only and passes the answer on', async () => {
    const answer = backlogView({ paused: true });
    vi.mocked(mergeBacklogTask).mockResolvedValue(answer);
    const onView = vi.fn();
    panel('ada', onView);

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));

    expect(mergeBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay');
    expect(onView).toHaveBeenCalledWith(answer);
  });

  it('hides Merge from anyone else', () => {
    panel('grace');

    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });

  it('shows a refusal', async () => {
    vi.mocked(mergeBacklogTask).mockRejectedValue(new Error('Not green yet'));
    panel('ada');

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not green yet');
  });

  it('says so when no milestone is active', () => {
    render(
      <MilestonePanel
        view={backlogView({ milestones: [] })}
        chat={backlogChatView()}
        login="ada"
        onView={vi.fn()}
        onChat={vi.fn()}
      />,
    );

    expect(screen.getByText('No milestone is active.')).toBeInTheDocument();
  });
});

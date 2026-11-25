import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addBacklogTasks,
  changeBacklogTask,
  deleteBacklogTask,
  mergeBacklogTask,
  runBacklogTaskNow,
  skipBacklogTask,
} from '../../../lib/backlog-endpoints';
import { backlogChatView, backlogView, milestone, task } from '../../../test/backlog-fixtures';
import { BacklogSections } from './backlog-sections';
import { MilestonePanel } from './milestone-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('../../../lib/backlog-endpoints', () => ({
  addBacklogTasks: vi.fn(),
  changeBacklogTask: vi.fn(),
  deleteBacklogTask: vi.fn(),
  skipBacklogTask: vi.fn(),
  runBacklogTaskNow: vi.fn(),
  mergeBacklogTask: vi.fn(),
  runBacklog: vi.fn(),
  runMilestone: vi.fn(),
}));

let user: UserEvent;

const answer = backlogView({ name: 'answer' });
const view = backlogView({
  repositories: ['shop', 'api'],
  milestones: [
    milestone(),
    milestone({ number: 4, title: 'Search', status: 'queued' }),
    milestone({ number: 2, title: 'Old', status: 'accepted' }),
  ],
  tasks: [
    task({ slug: 'pay', title: 'Pay by card', description: 'Old text', milestone: 3 }),
    task({ slug: 'started', title: 'Started one', runKey: 'run-7', milestone: 3, status: 'running' }),
    task({ slug: 'later', title: 'Later one', milestone: 4 }),
    task({ slug: 'item', title: 'Loose item', milestone: null }),
  ],
});

function panel(login: string | null = 'ada', onView = vi.fn()): void {
  render(<MilestonePanel view={view} chat={backlogChatView()} login={login} onView={onView} onChat={vi.fn()} />);
}

async function sections(login: string | null = 'ada', onView = vi.fn()): Promise<void> {
  render(<BacklogSections view={view} chat={backlogChatView()} login={login} onView={onView} onChat={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /Planned milestones/ }));
  await user.click(screen.getByRole('button', { name: /M4 · Search/ }));
  await user.click(screen.getByRole('button', { name: /Backlog items/ }));
}

async function openMenu(title: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: `Actions for ${title}` }));
}

async function openEdit(title: string): Promise<void> {
  panel();
  await openMenu(title);
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
}

function dropOn(list: HTMLElement, slug: string): void {
  fireEvent.drop(list, { dataTransfer: { getData: () => slug } });
}

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(addBacklogTasks).mockReset().mockResolvedValue(answer);
  vi.mocked(changeBacklogTask).mockReset().mockResolvedValue(answer);
  vi.mocked(deleteBacklogTask).mockReset().mockResolvedValue(answer);
  vi.mocked(skipBacklogTask).mockReset().mockResolvedValue(answer);
  vi.mocked(runBacklogTaskNow).mockReset().mockResolvedValue(answer);
  vi.mocked(mergeBacklogTask).mockReset();
});

describe('task editing', () => {
  it('adds a task with + Task into the preset milestone and passes the answer on', async () => {
    const onView = vi.fn();
    panel('ada', onView);
    await user.click(screen.getByRole('button', { name: '+ Task' }));
    await user.click(screen.getByLabelText('Title'));
    await user.paste('Pay by card');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(addBacklogTasks).toHaveBeenCalledWith('swarmloop', [
      expect.objectContaining({ id: 'pay-by-card', title: 'Pay by card', milestone: 3 }),
    ]);
    expect(onView).toHaveBeenCalledWith(answer);
  });

  it('adds a backlog item with a null milestone', async () => {
    render(<BacklogSections view={view} chat={backlogChatView()} login="ada" onView={vi.fn()} onChat={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Backlog items/ }));
    await user.click(screen.getAllByRole('button', { name: '+ Task' }).at(-1)!);
    await user.click(screen.getByLabelText('Title'));
    await user.paste('Fresh');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(addBacklogTasks).toHaveBeenCalledWith('swarmloop', [
      expect.objectContaining({ id: 'fresh', milestone: null }),
    ]);
  });

  it('edits the title and the description with a preview', async () => {
    await openEdit('Pay by card');
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.paste('Pay later');
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.paste('**bold** text');
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(changeBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay', {
      title: 'Pay later',
      description: '**bold** text',
    });
  });

  it('edits the repositories and the dependencies', async () => {
    await openEdit('Pay by card');
    await user.click(screen.getByRole('combobox', { name: 'Repositories' }));
    await user.click(screen.getByRole('option', { name: 'api' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('combobox', { name: 'Dependencies' }));
    expect(screen.queryByRole('option', { name: 'Pay by card' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Later one' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(changeBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay', {
      repositories: ['shop', 'api'],
      depends: ['later'],
    });
  });

  it('edits the milestone and does not offer an accepted one', async () => {
    await openEdit('Pay by card');
    await user.click(screen.getByRole('combobox', { name: 'Milestone' }));
    expect(screen.queryByRole('option', { name: /Old/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Backlog items' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(changeBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay', { milestone: null });
  });

  it('moves by Move to and does not offer an accepted milestone', async () => {
    panel();
    await openMenu('Pay by card');
    await user.click(screen.getByRole('menuitem', { name: 'Move to' }));
    expect(screen.queryByRole('menuitem', { name: /Old/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'M4 · Search' }));

    expect(changeBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay', { milestone: 4 });
  });

  it('moves by a drop onto a milestone list and onto the backlog items, and shows a refusal', async () => {
    const onView = vi.fn();
    await sections('ada', onView);
    dropOn(screen.getByText('Later one').closest('ul')!, 'pay');
    await vi.waitFor(() => expect(onView).toHaveBeenCalledWith(answer));
    expect(changeBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay', { milestone: 4 });

    vi.mocked(changeBacklogTask).mockRejectedValueOnce(new Error('Not allowed'));
    dropOn(screen.getByText('Loose item').closest('ul')!, 'later');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    expect(changeBacklogTask).toHaveBeenLastCalledWith('swarmloop', 'later', { milestone: null });
  });

  it('makes only a row without a run draggable', () => {
    panel();
    expect(screen.getByText('Pay by card').closest('li')).toHaveAttribute('draggable', 'true');
    expect(screen.getByText('Started one').closest('li')).not.toHaveAttribute('draggable');
  });

  it('offers Run now to the owner outside the active milestone only', async () => {
    await sections();
    await openMenu('Later one');
    await user.click(screen.getByRole('menuitem', { name: 'Run now' }));
    expect(runBacklogTaskNow).toHaveBeenCalledWith('swarmloop', 'later');
  });

  it('does not offer Run now inside the active milestone or to a non-owner', async () => {
    panel();
    await openMenu('Pay by card');
    expect(screen.queryByRole('menuitem', { name: 'Run now' })).not.toBeInTheDocument();
  });

  it('does not offer Run now to a person who is not the owner', async () => {
    await sections('bob');
    await openMenu('Later one');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Run now' })).not.toBeInTheDocument();
  });

  it('asks before Delete and deletes only after the confirm', async () => {
    const onView = vi.fn();
    panel('ada', onView);
    await openMenu('Pay by card');
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(deleteBacklogTask).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: /Pay by card/ });
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }));

    expect(deleteBacklogTask).toHaveBeenCalledWith('swarmloop', 'pay');
    await vi.waitFor(() => expect(onView).toHaveBeenCalledWith(answer));
  });

  it('offers a started task Open run and Skip, and Skip asks first', async () => {
    panel();
    await openMenu('Started one');
    expect(screen.getByRole('menuitem', { name: 'Open run' })).toHaveAttribute('href', '/runs/run-7');
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Skip' }));
    expect(skipBacklogTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Skip task' }));

    expect(skipBacklogTask).toHaveBeenCalledWith('swarmloop', 'started');
  });

  it('shows a refusal of Move to as an alert', async () => {
    vi.mocked(changeBacklogTask).mockRejectedValue(new Error('Task already started'));
    panel();
    await openMenu('Pay by card');
    await user.click(screen.getByRole('menuitem', { name: 'Move to' }));
    await user.click(screen.getByRole('menuitem', { name: 'M4 · Search' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Task already started');
  });
});

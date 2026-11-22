import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBacklog } from '../../lib/backlog-endpoints';
import { createRepository, listProjects, listRemote } from '../../lib/endpoints';
import { backlogView } from '../../test/backlog-fixtures';
import { NewBacklogDialog } from './new-backlog-dialog';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../../lib/backlog-endpoints', () => ({ createBacklog: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({ createRepository: vi.fn(), listProjects: vi.fn(), listRemote: vi.fn() }));

let user: UserEvent;

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  push.mockReset();
  vi.mocked(listProjects).mockResolvedValue({ projects: ['shop', 'api'] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
});

async function fill(): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: 'Name' }));
  await user.paste('checkout');
  await user.click(await screen.findByRole('combobox', { name: 'Projects' }));
  await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'shop' }));
  await user.click(screen.getByRole('radio', { name: 'wait for my OK' }));
}

describe('NewBacklogDialog', () => {
  it('creates the backlog with its name, repositories and merge mode, then opens it', async () => {
    vi.mocked(createBacklog).mockResolvedValue(backlogView({ name: 'checkout' }));
    render(<NewBacklogDialog open onClose={vi.fn()} />);

    await fill();
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createBacklog).toHaveBeenCalledWith({ name: 'checkout', repositories: ['shop'], mergeMode: 'ok' });
    expect(push).toHaveBeenCalledWith('/backlogs/checkout');
  });

  it('includes a repository created through ProjectPicker with the picked repositories', async () => {
    vi.mocked(listRemote).mockResolvedValue({
      repositories: [],
      owners: [{ host: 'github', login: 'acme', kind: 'organization' }],
      reason: null,
      allowedNames: [],
    });
    vi.mocked(createRepository).mockResolvedValue({
      host: 'github',
      owner: 'acme',
      name: 'payments',
      visibility: 'private',
      defaultBranch: 'main',
      cloned: true,
    });
    vi.mocked(createBacklog).mockResolvedValue(backlogView({ name: 'checkout' }));
    render(<NewBacklogDialog open onClose={vi.fn()} />);

    await fill();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New repository' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'New repository' }));
    await user.click(await screen.findByRole('textbox', { name: 'Name' }));
    await user.paste('payments');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('checkout'));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createBacklog).toHaveBeenCalledWith({
        name: 'checkout',
        repositories: ['shop', 'payments'],
        mergeMode: 'ok',
      }),
    );
    expect(push).toHaveBeenCalledWith('/backlogs/checkout');
  });

  it('shows the refusal of the server as an alert and stays', async () => {
    vi.mocked(createBacklog).mockRejectedValue(new Error('A backlog named checkout exists'));
    render(<NewBacklogDialog open onClose={vi.fn()} />);

    await fill();
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A backlog named checkout exists');
    expect(push).not.toHaveBeenCalled();
  });
});

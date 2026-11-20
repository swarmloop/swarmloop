import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBacklog } from '../../lib/backlog-endpoints';
import { createRepository, listProjects, listRemote } from '../../lib/endpoints';
import { backlogView } from '../../test/backlog-fixtures';
import { NewBacklogDialog } from './new-backlog-dialog';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../../lib/backlog-endpoints', () => ({ createBacklog: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({ createRepository: vi.fn(), listProjects: vi.fn(), listRemote: vi.fn() }));

beforeEach(() => {
  push.mockReset();
  vi.mocked(listProjects).mockResolvedValue({ projects: ['shop', 'api'] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
});

async function fill(): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'checkout');
  await userEvent.click(await screen.findByRole('combobox', { name: 'Projects' }));
  await userEvent.click(await screen.findByRole('option', { name: 'shop' }));
  await userEvent.click(screen.getByRole('radio', { name: 'wait for my OK' }));
}

describe('NewBacklogDialog', () => {
  it('creates the backlog with its name, repositories and merge mode, then opens it', async () => {
    vi.mocked(createBacklog).mockResolvedValue(backlogView({ name: 'checkout' }));
    render(<NewBacklogDialog open onClose={vi.fn()} />);

    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(createBacklog).toHaveBeenCalledWith({ name: 'checkout', repositories: ['shop'], mergeMode: 'ok' });
    expect(push).toHaveBeenCalledWith('/backlogs/checkout');
  });

  it('includes a repository created through ProjectPicker with the picked repositories', async () => {
    const user = userEvent.setup({ delay: null });
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
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'payments');
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
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A backlog named checkout exists');
    expect(push).not.toHaveBeenCalled();
  });
});

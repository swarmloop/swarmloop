import { render as renderInto, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addBacklogRepository } from '../../lib/backlog-endpoints';
import { listProjects, listRemote } from '../../lib/endpoints';
import { backlogView } from '../../test/backlog-fixtures';
import { LiveBridgeProvider } from '../shell';
import { AddRepositoryDialog } from './add-repository-dialog';

vi.mock('../../lib/backlog-endpoints', () => ({ addBacklogRepository: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({
  createRepository: vi.fn(),
  getCommand: vi.fn(),
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  refreshRemote: vi.fn(),
}));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

const render = (ui: ReactElement) => renderInto(ui, { wrapper: LiveBridgeProvider });

const view = backlogView({ repositories: ['shop'] });

let user: UserEvent;

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(listProjects).mockResolvedValue({ projects: ['shop', 'api'] });
  vi.mocked(listRemote).mockResolvedValue({
    repositories: [
      { host: 'github', owner: 'acme', name: 'app', visibility: 'private', defaultBranch: 'main', cloned: false },
    ],
    owners: [],
    reason: null,
    allowedNames: [],
    loading: false,
    error: null,
  });
});

async function openOptions(): Promise<HTMLElement> {
  await user.click(await screen.findByRole('combobox', { name: 'Projects' }));
  return screen.findByRole('listbox');
}

describe('AddRepositoryDialog', () => {
  it('offers the folders not in scope and the repositories not cloned yet, and sends the pick by owner and name', async () => {
    const answer = backlogView({ repositories: ['shop', 'app'] });
    vi.mocked(addBacklogRepository).mockResolvedValue(answer);
    const onView = vi.fn();
    const onClose = vi.fn();
    render(<AddRepositoryDialog open view={view} onClose={onClose} onView={onView} />);

    const options = within(await openOptions()).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('api');
    expect(options[1]).toHaveTextContent('acme/app');
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /acme\/app/ }));

    expect(addBacklogRepository).toHaveBeenCalledWith(view.name, { repository: 'acme/app' });
    expect(onView).toHaveBeenCalledWith(answer);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the refusal of the server as an alert and stays open', async () => {
    vi.mocked(addBacklogRepository).mockRejectedValue(new Error('acme/app cannot be cloned: no access'));
    const onClose = vi.fn();
    render(<AddRepositoryDialog open view={view} onClose={onClose} onView={vi.fn()} />);

    await openOptions();
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /acme\/app/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('acme/app cannot be cloned: no access');
    expect(onClose).not.toHaveBeenCalled();
  });
});

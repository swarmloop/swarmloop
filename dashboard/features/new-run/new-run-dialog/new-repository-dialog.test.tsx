import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryOwner } from '@contract/api';
import { createRepository } from '../../../lib/endpoints';
import { NewRepositoryDialog } from './new-repository-dialog';

vi.mock('../../../lib/endpoints', () => ({ createRepository: vi.fn() }));

const owners: RepositoryOwner[] = [
  { host: 'github', login: 'me', kind: 'user' },
  { host: 'gitlab', login: 'team', kind: 'group' },
];

function open(allowedNames: string[] = [], onCreated = vi.fn(), onClose = vi.fn()) {
  render(
    <NewRepositoryDialog open owners={owners} allowedNames={allowedNames} onClose={onClose} onCreated={onCreated} />,
  );
  return { onCreated, onClose };
}

beforeEach(() => {
  vi.mocked(createRepository).mockReset();
});

describe('NewRepositoryDialog', () => {
  it('validates the name as you type', async () => {
    const user = userEvent.setup();
    open(['demo']);
    const name = screen.getByRole('textbox', { name: 'Name' });
    const create = screen.getByRole('button', { name: 'Create' });

    expect(create).toBeDisabled();
    for (const [text, problem] of [
      ['my repo', /letters, digits/i],
      ['.hidden', /cannot start/],
      ['demo.git', /cannot end with .git/],
      ['other', /not in SWARMLOOP_REPOS/],
    ] as const) {
      await user.clear(name);
      await user.type(name, text);
      expect(screen.getByText(problem)).toBeInTheDocument();
      expect(create).toBeDisabled();
    }
    await user.clear(name);
    await user.type(name, 'demo');
    expect(create).toBeEnabled();
  });

  it('is private by default, sends Public only when it is checked, and selects the new repository', async () => {
    const user = userEvent.setup();
    const created = {
      host: 'github',
      owner: 'me',
      name: 'demo',
      visibility: 'private',
      defaultBranch: 'main',
      cloned: true,
    };
    vi.mocked(createRepository).mockResolvedValue(created as never);
    const { onCreated, onClose } = open();

    expect(screen.getByRole('checkbox', { name: 'Public' })).not.toBeChecked();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(createRepository).toHaveBeenCalledWith({ host: 'github', owner: 'me', name: 'demo', public: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('passes the host of the chosen owner and Public along', async () => {
    const user = userEvent.setup();
    vi.mocked(createRepository).mockResolvedValue({} as never);
    open();

    await user.click(screen.getByRole('combobox', { name: 'Owner' }));
    await user.click(await screen.findByRole('option', { name: 'team' }));
    await user.click(screen.getByRole('checkbox', { name: 'Public' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createRepository).toHaveBeenCalledWith({ host: 'gitlab', owner: 'team', name: 'demo', public: true });
  });

  it('shows the spinner while it creates and the host error inline when it fails', async () => {
    const user = userEvent.setup();
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(createRepository).mockReturnValue(new Promise((_done, reject) => (fail = reject)));
    const { onCreated } = open();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('progressbar', { name: 'Creating' })).toBeInTheDocument();

    fail(new Error('Resource not accessible (needs repo scope)'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Resource not accessible (needs repo scope)');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

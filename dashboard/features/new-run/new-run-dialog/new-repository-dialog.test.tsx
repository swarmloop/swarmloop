import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryOwner } from '@contract/api';
import type { CommandView } from '@contract/command';
import { createRepository, getCommand } from '../../../lib/endpoints';
import { receive } from '../../../test/fake-socket';
import { LiveBridgeProvider } from '../../shell';
import { NewRepositoryDialog } from './new-repository-dialog';

vi.mock('../../../lib/endpoints', () => ({ createRepository: vi.fn(), getCommand: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return <LiveBridgeProvider>{children}</LiveBridgeProvider>;
}

const view = (state: CommandView['state'], extra: Partial<CommandView> = {}): CommandView => ({
  commandId: 'c1',
  type: 'create-repository',
  state,
  value: null,
  error: null,
  ...extra,
});

const owners: RepositoryOwner[] = [
  { host: 'github', login: 'me', kind: 'user' },
  { host: 'gitlab', login: 'team', kind: 'group' },
];

function open(allowedNames: string[] = [], existingNames: string[] = []) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const onLost = vi.fn();
  render(
    <NewRepositoryDialog
      open
      owners={owners}
      allowedNames={allowedNames}
      existingNames={existingNames}
      onClose={onClose}
      onLost={onLost}
      onCreated={onCreated}
    />,
    { wrapper: Wrapper },
  );
  return { onCreated, onClose, onLost };
}

beforeEach(() => {
  vi.mocked(createRepository).mockReset().mockResolvedValue({ commandId: 'c1' });
  vi.mocked(getCommand)
    .mockReset()
    .mockResolvedValue(view('succeeded', { value: {} }));
});

describe('NewRepositoryDialog', () => {
  it('validates the name as you type', async () => {
    const user = userEvent.setup({ delay: null });
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

  it('refuses a name that already exists and keeps Create off', async () => {
    const user = userEvent.setup({ delay: null });
    open([], ['shop']);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'shop');

    expect(screen.getByText('shop already exists')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('is private by default, sends Public only when it is checked, and selects the new repository', async () => {
    const user = userEvent.setup({ delay: null });
    const created = {
      host: 'github',
      owner: 'me',
      name: 'demo',
      visibility: 'private',
      defaultBranch: 'main',
      cloned: true,
    };
    vi.mocked(getCommand).mockResolvedValue(view('succeeded', { value: created }));
    const { onCreated, onClose } = open();

    expect(screen.getByRole('checkbox', { name: 'Public' })).not.toBeChecked();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(createRepository).toHaveBeenCalledWith(
      { host: 'github', owner: 'me', name: 'demo', public: false },
      expect.any(String),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('passes the host of the chosen owner and Public along', async () => {
    const user = userEvent.setup({ delay: null });
    open();

    await user.click(screen.getByRole('combobox', { name: 'Owner' }));
    await user.click(await screen.findByRole('option', { name: 'team' }));
    await user.click(screen.getByRole('checkbox', { name: 'Public' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createRepository).toHaveBeenCalledWith(
      { host: 'gitlab', owner: 'team', name: 'demo', public: true },
      expect.any(String),
    );
  });

  it('waits for the command and calls onCreated only when it has succeeded', async () => {
    const user = userEvent.setup({ delay: null });
    const created = { host: 'github', owner: 'me', name: 'demo', cloned: true };
    vi.mocked(getCommand).mockResolvedValueOnce(view('executing'));
    const { onCreated } = open();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('progressbar', { name: 'Creating' })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();

    vi.mocked(getCommand).mockResolvedValue(view('succeeded', { value: created }));
    act(() => receive('command', { commandId: 'c1', state: 'succeeded' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows the message of a failed command and sends a new key on the next Create', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(getCommand).mockResolvedValue(
      view('failed', { error: { message: 'Resource not accessible (needs repo scope)' } }),
    );
    const { onCreated } = open();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Resource not accessible (needs repo scope)');
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createRepository).toHaveBeenCalledTimes(2));
    const keys = vi.mocked(createRepository).mock.calls.map((call) => call[1]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('on a lost answer shows the message, asks for the list again and replays the same key', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(createRepository).mockRejectedValueOnce(new Error('The server is busy'));
    const { onLost } = open();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The server is busy');
    expect(onLost).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createRepository).toHaveBeenCalledTimes(2));
    const keys = vi.mocked(createRepository).mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);
  });
});

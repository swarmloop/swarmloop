import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepository, createRun, listProjects, listRemote, ticketKeys } from '../../../lib/endpoints';
import { NewRunDialog } from './index';

vi.mock('../../../lib/endpoints', () => ({
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  createRepository: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  ticketKeys: vi.fn(),
}));

const allPhases = ['planning', 'implementation', 'checks', 'code-review', 'ci'];

// One paste is one change event; typing it key by key re-renders the whole dialog per character.
async function pastePrompt(user: UserEvent, text: string): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: /Prompt/ }));
  await user.paste(text);
}

async function pickProject(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Projects' }));
  await user.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  vi.mocked(listProjects).mockResolvedValue({ projects: ['swarmloop', 'docs'] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
  vi.mocked(createRun).mockResolvedValue({ key: 'run-9', status: 'running' });
  vi.mocked(ticketKeys).mockResolvedValue({ keys: [] });
});

describe('NewRunDialog', () => {
  it('keeps Start disabled until a prompt and a project are set', async () => {
    const user = userEvent.setup();
    render(<NewRunDialog open onClose={vi.fn()} />);
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();

    await pastePrompt(user, 'Ship it');
    expect(start).toBeDisabled();

    await pickProject(user, 'swarmloop');
    expect(start).toBeEnabled();
  });

  it('lists the Jira keys that will be fetched, or says there are none', async () => {
    const user = userEvent.setup();
    vi.mocked(ticketKeys).mockResolvedValueOnce({ keys: ['PROJ-12', 'PROJ-13'] });
    render(<NewRunDialog open onClose={vi.fn()} />);

    await pastePrompt(user, 'Do PROJ-12 and PROJ-13');
    expect(await screen.findByText('Jira: PROJ-12, PROJ-13')).toBeInTheDocument();

    vi.mocked(ticketKeys).mockResolvedValue({ keys: [] });
    await pastePrompt(user, ' now');
    expect(await screen.findByText('no Jira tickets')).toBeInTheDocument();
  });

  it('starts with all five phases checked', () => {
    render(<NewRunDialog open onClose={vi.fn()} />);

    const phases = screen.getAllByRole('checkbox', { name: /^(?!May split)/ });
    expect(phases).toHaveLength(5);
    phases.forEach((phase) => expect(phase).toBeChecked());
  });

  it('posts the prompt, phases and projects to /runs without ci once ci is unchecked', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<NewRunDialog open onClose={vi.fn()} onCreated={onCreated} />);

    await user.click(screen.getByRole('checkbox', { name: 'ci' }));
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('run-9'));
    expect(createRun).toHaveBeenCalledWith({
      prompt: 'Ship it',
      phases: ['planning', 'implementation', 'checks', 'code-review'],
      projects: ['swarmloop'],
      split: false,
    });
  });

  it('split checkbox default follows the server value', async () => {
    vi.mocked(listProjects).mockResolvedValue({ projects: ['swarmloop'], split: true });
    render(<NewRunDialog open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'May split into subtasks' })).toBeChecked());
  });

  it('sends split in the payload', async () => {
    const user = userEvent.setup();
    render(<NewRunDialog open onClose={vi.fn()} />);
    await user.click(screen.getByRole('checkbox', { name: 'May split into subtasks' }));
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ split: true })));
  });

  it('hands the prompt and phases to onSubmit instead of posting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewRunDialog open onClose={onClose} onSubmit={onSubmit} />);
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Ship it', allPhases);
  });

  it('shows the error when the POST to /runs fails', async () => {
    const user = userEvent.setup();
    vi.mocked(listProjects).mockResolvedValue({ projects: ['swarmloop'] });
    vi.mocked(createRun).mockRejectedValue(new Error('run refused'));
    render(<NewRunDialog open onClose={vi.fn()} />);
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('run refused')).toBeInTheDocument();
  });
  it('keeps local folders working when the remote list fails', async () => {
    const user = userEvent.setup();
    vi.mocked(listRemote).mockRejectedValue(new Error('GitHub is down'));
    render(<NewRunDialog open onClose={vi.fn()} />);

    await pickProject(user, 'swarmloop');

    expect(screen.getByRole('button', { name: 'New repository' })).toBeDisabled();
    expect(screen.queryByText('GitHub is down')).not.toBeInTheDocument();
  });

  it('creates two repositories in a row without closing the dialog and picks both', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(listRemote).mockResolvedValue({
      repositories: [],
      owners: [{ host: 'github', login: 'acme', kind: 'organization' }],
      reason: null,
      allowedNames: [],
    });
    vi.mocked(createRepository).mockImplementation(async (body) => ({
      host: body.host,
      owner: body.owner,
      name: body.name,
      visibility: 'private',
      defaultBranch: 'main',
      cloned: true,
    }));
    render(<NewRunDialog open onClose={onClose} />);

    for (const name of ['first', 'second']) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'New repository' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'New repository' }));
      await user.type(await screen.findByRole('textbox', { name: 'Name' }), name);
      await user.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument());
    }

    expect(createRepository).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    await pastePrompt(user, 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ projects: ['first', 'second'] })),
    );
  });
});

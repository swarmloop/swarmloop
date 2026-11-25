import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepository, createRun, listProjects, listRemote, ticketKeys, uploadFile } from '../../../lib/endpoints';
import { NewRunDialog, PREVIEW_DELAY_MS } from './index';

vi.mock('../../../lib/endpoints', () => ({
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  createRepository: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  ticketKeys: vi.fn(),
  uploadFile: vi.fn(),
}));

const allPhases = ['planning', 'implementation', 'checks', 'code-review', 'ci'];

// One paste is one change event; typing it key by key re-renders the whole dialog per character.
async function pastePrompt(user: UserEvent, text: string): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: /Prompt/ }));
  await user.paste(text);
}

async function attachShot(user: UserEvent): Promise<void> {
  await user.upload(screen.getByTestId('composer-file-input'), new File(['abc'], 'shot.png', { type: 'image/png' }));
  await screen.findByText('shot.png');
}

async function pickProject(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Projects' }));
  await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name }));
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(listProjects).mockResolvedValue({ projects: ['swarmloop', 'docs'] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
  vi.mocked(createRun).mockResolvedValue({ key: 'run-9', status: 'running' });
  vi.mocked(ticketKeys).mockResolvedValue({ keys: [] });
});

describe('NewRunDialog', () => {
  it('keeps Start disabled until a prompt and a project are set', async () => {
    const user = userEvent.setup({ delay: null });
    render(<NewRunDialog open onClose={vi.fn()} />);
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();

    await pastePrompt(user, 'Ship it');
    expect(start).toBeDisabled();

    await pickProject(user, 'swarmloop');
    expect(start).toBeEnabled();
  });

  it('lists the Jira keys that will be fetched, or says there are none', async () => {
    // user-event waits on real timers, which fake time would stall: one change event stands for the paste.
    vi.useFakeTimers();
    vi.mocked(ticketKeys).mockResolvedValueOnce({ keys: ['PROJ-12', 'PROJ-13'] });
    render(<NewRunDialog open onClose={vi.fn()} />);

    const prompt = screen.getByRole('textbox', { name: /Prompt/ });
    fireEvent.change(prompt, { target: { value: 'Do PROJ-12 and PROJ-13' } });
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS));
    expect(screen.getByText('Jira: PROJ-12, PROJ-13')).toBeInTheDocument();

    vi.mocked(ticketKeys).mockResolvedValue({ keys: [] });
    fireEvent.change(prompt, { target: { value: 'Do PROJ-12 and PROJ-13 now' } });
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS));
    expect(screen.getByText('no Jira tickets')).toBeInTheDocument();
  });

  it('starts with all five phases checked', () => {
    render(<NewRunDialog open onClose={vi.fn()} />);

    const phases = screen.getAllByRole('checkbox');
    expect(phases).toHaveLength(5);
    phases.forEach((phase) => expect(phase).toBeChecked());
  });

  it('posts the prompt, phases and projects to /runs without ci once ci is unchecked', async () => {
    const user = userEvent.setup({ delay: null });
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
    });
  });

  it('renders no split control and sends no split', async () => {
    const user = userEvent.setup({ delay: null });
    render(<NewRunDialog open onClose={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: /split/i })).not.toBeInTheDocument();
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(createRun).toHaveBeenCalled());
    expect(vi.mocked(createRun).mock.lastCall![0]).not.toHaveProperty('split');
  });

  it('hands the prompt and phases to onSubmit instead of posting', async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewRunDialog open onClose={onClose} onSubmit={onSubmit} />);
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith());
    expect(onSubmit).toHaveBeenCalledWith('Ship it', allPhases);
  });

  it('sends the upload ids with a new run', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(uploadFile).mockResolvedValue({ id: 'u1', name: 'shot.png', size: 3 });
    render(<NewRunDialog open onClose={vi.fn()} />);
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');
    await attachShot(user);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(createRun).toHaveBeenCalled());
    expect(vi.mocked(createRun).mock.lastCall![0]).toMatchObject({ attachments: ['u1'] });
  });

  it('sends the upload ids with onSubmit', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(uploadFile).mockResolvedValue({ id: 'u1', name: 'shot.png', size: 3 });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open onClose={vi.fn()} onSubmit={onSubmit} />);
    await pastePrompt(user, 'Again');
    await pickProject(user, 'swarmloop');
    await attachShot(user);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Again', allPhases, ['u1']));
  });

  it('fills the prompt from initialPrompt', () => {
    render(<NewRunDialog open onClose={vi.fn()} initialPrompt="Follow up on run-3" />);

    expect(screen.getByRole('textbox', { name: /Prompt/ })).toHaveValue('Follow up on run-3');
  });

  it('shows the error when the POST to /runs fails', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(listProjects).mockResolvedValue({ projects: ['swarmloop'] });
    vi.mocked(createRun).mockRejectedValue(new Error('run refused'));
    render(<NewRunDialog open onClose={vi.fn()} />);
    await pastePrompt(user, 'Ship it');
    await pickProject(user, 'swarmloop');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('run refused')).toBeInTheDocument();
  });
  it('keeps local folders working when the remote list fails', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(listRemote).mockRejectedValue(new Error('GitHub is down'));
    render(<NewRunDialog open onClose={vi.fn()} />);

    await pickProject(user, 'swarmloop');

    expect(screen.getByRole('button', { name: 'New repository' })).toBeDisabled();
    expect(screen.queryByText('GitHub is down')).not.toBeInTheDocument();
  });

  it('creates two repositories in a row without closing the dialog and picks both', async () => {
    const user = userEvent.setup({ delay: null });
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
      await user.click(await screen.findByRole('textbox', { name: 'Name' }));
      await user.paste(name);
      await user.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument());
    }

    expect(createRepository).toHaveBeenNthCalledWith(1, expect.objectContaining({ owner: 'acme', name: 'first' }));
    expect(createRepository).toHaveBeenNthCalledWith(2, expect.objectContaining({ owner: 'acme', name: 'second' }));
    expect(onClose).not.toHaveBeenCalled();
    await pastePrompt(user, 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ projects: ['first', 'second'] })),
    );
  });
});

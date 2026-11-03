import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { NewRunDialog } from './index';

vi.mock('../../lib/api', () => ({ api: vi.fn(), runLog: vi.fn() }));

const allPhases = ['requirements', 'brainstorm', 'implementation', 'code-review', 'ci'];

async function pickProject(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Projects' }));
  await user.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { key: 'run-9' };
    }
    if (path === '/checkouts/projects') {
      return { projects: ['swarmloop', 'docs'] };
    }
    throw new Error(`unexpected ${path}`);
  });
});

describe('NewRunDialog', () => {
  it('keeps Start disabled until a prompt and a project are set', async () => {
    const user = userEvent.setup();
    render(<NewRunDialog open onClose={vi.fn()} />);
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: /Prompt/ }), 'Ship it');
    expect(start).toBeDisabled();

    await pickProject(user, 'swarmloop');
    expect(start).toBeEnabled();
  });

  it('starts with all five phases checked', () => {
    render(<NewRunDialog open onClose={vi.fn()} />);

    const phases = screen.getAllByRole('checkbox');
    expect(phases).toHaveLength(5);
    phases.forEach((phase) => expect(phase).toBeChecked());
  });

  it('posts the prompt, phases and projects to /runs without ci once ci is unchecked', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<NewRunDialog open onClose={vi.fn()} onCreated={onCreated} />);

    await user.click(screen.getByRole('checkbox', { name: 'ci' }));
    await user.type(screen.getByRole('textbox', { name: /Prompt/ }), 'Ship it');
    await pickProject(user, 'swarmloop');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('run-9'));
    expect(api).toHaveBeenCalledWith('/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Ship it',
        phases: ['requirements', 'brainstorm', 'implementation', 'code-review'],
        projects: ['swarmloop'],
      }),
    });
  });

  it('hands the prompt and phases to onSubmit instead of posting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewRunDialog open onClose={onClose} onSubmit={onSubmit} />);
    await user.type(screen.getByRole('textbox', { name: /Prompt/ }), 'Ship it');
    await pickProject(user, 'swarmloop');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('Ship it', allPhases);
  });

  it('shows the error when the POST to /runs fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        throw new Error('run refused');
      }
      return { projects: ['swarmloop'] };
    });
    render(<NewRunDialog open onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: /Prompt/ }), 'Ship it');
    await pickProject(user, 'swarmloop');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('run refused')).toBeInTheDocument();
  });
});

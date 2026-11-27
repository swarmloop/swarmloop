import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { saveApplication } from '../../lib/endpoints';
import { ApplicationForm } from './application-form';

vi.mock('../../lib/endpoints', () => ({ saveApplication: vi.fn() }));

const setup = {
  provider: 'gitlab',
  page: 'https://git.corp.example/-/user_settings/applications',
  callback: 'https://swarm.example/auth/gitlab/callback',
  scopes: ['read_user', 'api', 'write_repository'],
};
const texts = { idLabel: 'Application ID', secretLabel: 'Secret', confidential: "Leave 'Confidential' ticked." };
const onSaved = vi.fn();
const user = userEvent.setup({ delay: null });

function renderForm(replacing?: { name: string; connected: string[] }): void {
  render(<ApplicationForm setup={setup} label="GitLab" texts={texts} replacing={replacing} onSaved={onSaved} />);
}

async function fill(): Promise<void> {
  await user.type(screen.getByLabelText(/Application ID/), ' gl-id ');
  await user.type(screen.getByLabelText(/Secret/), ' gl-secret ');
}

beforeEach(() => {
  vi.mocked(saveApplication).mockReset();
  onSaved.mockReset();
});
afterEach(cleanup);

describe('ApplicationForm', () => {
  it('shows the page link, the callback, the scopes and Confidential', () => {
    renderForm();
    const link = screen.getByRole('link', { name: 'Open Applications on git.corp.example' });
    expect(link).toHaveAttribute('href', setup.page);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByLabelText('Callback URL')).toHaveValue(setup.callback);
    expect(screen.getByLabelText('Callback URL')).toHaveAttribute('readonly');
    expect(screen.getByText(/read_user, api, write_repository/)).toBeInTheDocument();
    expect(screen.getByText("Leave 'Confidential' ticked.")).toBeInTheDocument();
  });

  it('copies the callback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(setup.callback);
  });

  it('posts the trimmed values and reports a save', async () => {
    vi.mocked(saveApplication).mockResolvedValue({ ok: true });
    renderForm();
    await fill();
    await user.click(screen.getByRole('button', { name: 'Connect GitLab' }));
    expect(saveApplication).toHaveBeenCalledWith('gitlab', 'gl-id', 'gl-secret');
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('marks both fields with the message on a 422', async () => {
    vi.mocked(saveApplication).mockRejectedValue(
      new ApiError(422, 'GitLab did not accept this Application ID and Secret.'),
    );
    renderForm();
    await fill();
    await user.click(screen.getByRole('button', { name: 'Connect GitLab' }));
    expect(await screen.findByText('GitLab did not accept this Application ID and Secret.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Application ID/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Secret/)).toHaveAttribute('aria-invalid', 'true');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows any other error in an alert', async () => {
    vi.mocked(saveApplication).mockRejectedValue(new ApiError(403, 'Only an admin can replace this application.'));
    renderForm();
    await fill();
    await user.click(screen.getByRole('button', { name: 'Connect GitLab' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an admin can replace this application.');
    expect(screen.getByLabelText(/Application ID/)).toHaveAttribute('aria-invalid', 'false');
  });

  describe('replacing', () => {
    it('asks first, naming who is disconnected, and posts only after the confirm', async () => {
      vi.mocked(saveApplication).mockResolvedValue({ ok: true });
      renderForm({ name: 'OAuth application', connected: ['alice', 'bob'] });
      await fill();
      await user.click(screen.getByRole('button', { name: 'Replace application' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Replace OAuth application?');
      expect(dialog).toHaveTextContent('alice, bob will be disconnected');
      expect(saveApplication).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Replace application' }));
      await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(saveApplication).toHaveBeenCalledWith('gitlab', 'gl-id', 'gl-secret');
    });

    it('marks both fields and closes the dialog on a 422', async () => {
      vi.mocked(saveApplication).mockRejectedValue(
        new ApiError(422, 'GitLab did not accept this Application ID and Secret.'),
      );
      renderForm({ name: 'OAuth application', connected: [] });
      await fill();
      await user.click(screen.getByRole('button', { name: 'Replace application' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Replace application' }));

      await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByText('GitLab did not accept this Application ID and Secret.')).toBeInTheDocument();
      expect(screen.getByLabelText(/Secret/)).toHaveAttribute('aria-invalid', 'true');
    });

    it('shows a 403 in the dialog', async () => {
      vi.mocked(saveApplication).mockRejectedValue(new ApiError(403, 'Only an admin can replace this application.'));
      renderForm({ name: 'OAuth application', connected: [] });
      await fill();
      await user.click(screen.getByRole('button', { name: 'Replace application' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Replace application' }));

      expect(await within(dialog).findByText('Only an admin can replace this application.')).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
    });
  });
});

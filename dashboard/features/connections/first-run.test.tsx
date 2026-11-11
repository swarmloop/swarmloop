import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getManifest, saveGitlabApplication } from '../../lib/endpoints';
import { FirstRun } from './first-run';

vi.mock('../../lib/endpoints', () => ({ getManifest: vi.fn(), saveGitlabApplication: vi.fn() }));

const submit = vi.fn();
beforeEach(() => {
  vi.mocked(getManifest).mockReset();
  vi.mocked(saveGitlabApplication).mockReset();
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
});
afterEach(() => vi.restoreAllMocks());

describe('FirstRun', () => {
  it('posts the manifest to the page GitHub gave, for the organization typed', async () => {
    vi.mocked(getManifest).mockResolvedValue({
      action: 'https://github.com/organizations/acme/settings/apps/new?state=s',
      manifest: { name: 'swarmloop-panel' },
    });
    render(<FirstRun />);
    await userEvent.type(screen.getByLabelText(/Organization/), 'acme');
    await userEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(getManifest).toHaveBeenCalledWith('acme');
    const form = document.querySelector('form[method="post"]') as HTMLFormElement;
    expect(form).toHaveAttribute('action', 'https://github.com/organizations/acme/settings/apps/new?state=s');
    expect(form.querySelector('input[name="manifest"]')).toHaveValue('{"name":"swarmloop-panel"}');
  });

  it('posts again on a second click, as after coming back from GitHub', async () => {
    vi.mocked(getManifest)
      .mockResolvedValueOnce({ action: 'https://github.com/settings/apps/new?state=one', manifest: {} })
      .mockResolvedValueOnce({ action: 'https://github.com/settings/apps/new?state=two', manifest: {} });
    render(<FirstRun />);
    await userEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(document.querySelector('form[method="post"]')).toHaveAttribute(
      'action',
      'https://github.com/settings/apps/new?state=two',
    );
  });

  it('offers Connect GitLab, which stores the application it is given', async () => {
    vi.mocked(saveGitlabApplication).mockRejectedValue(new Error('a login exists'));
    render(<FirstRun />);
    await userEvent.type(screen.getByLabelText(/Application ID/), 'gl-id');
    await userEvent.type(screen.getByLabelText(/Secret/), 'gl-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitLab' }));

    expect(saveGitlabApplication).toHaveBeenCalledWith('gl-id', 'gl-secret');
    expect(await screen.findByText('a login exists')).toBeInTheDocument();
  });
});

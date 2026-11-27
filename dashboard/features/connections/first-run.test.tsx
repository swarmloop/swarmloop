import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getManifest, getOwner } from '../../lib/endpoints';
import { FirstRun } from './first-run';

vi.mock('../../lib/endpoints', () => ({
  getManifest: vi.fn(),
  getOwner: vi.fn(),
  saveApplication: vi.fn(),
  signInWithToken: vi.fn(),
}));

const submit = vi.fn();
beforeEach(() => {
  vi.mocked(getManifest).mockReset();
  vi.mocked(getOwner).mockReset().mockResolvedValue({ owner: 'acme', others: [] });
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FirstRun', () => {
  it('posts the manifest to the page GitHub gave, for the organization typed', async () => {
    vi.mocked(getManifest).mockResolvedValue({
      action: 'https://github.com/organizations/acme/settings/apps/new?state=s',
      manifest: { name: 'swarmloop-panel' },
    });
    render(<FirstRun />);
    const field = screen.getByLabelText(/Account that owns the app/);
    await waitFor(() => expect(field).toHaveValue('acme'));
    await userEvent.setup({ delay: null }).clear(field);
    await userEvent.setup({ delay: null }).type(field, 'acme');
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Create GitHub App' }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
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
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Create GitHub App' }));
    await waitFor(() =>
      expect(document.querySelector('form[method="post"]')).toHaveAttribute(
        'action',
        'https://github.com/settings/apps/new?state=one',
      ),
    );
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Create GitHub App' }));

    await waitFor(() =>
      expect(document.querySelector('form[method="post"]')).toHaveAttribute(
        'action',
        'https://github.com/settings/apps/new?state=two',
      ),
    );
  });

  it('prefills the owner and sends it to the manifest', async () => {
    vi.mocked(getOwner).mockResolvedValue({ owner: 'beta', others: [] });
    vi.mocked(getManifest).mockResolvedValue({ action: 'https://github.com/x', manifest: {} });
    render(<FirstRun />);
    await waitFor(() => expect(screen.getByLabelText(/Account that owns the app/)).toHaveValue('beta'));
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Create GitHub App' }));

    await waitFor(() => expect(getManifest).toHaveBeenCalledWith('beta'));
  });

  it('names the other owners in one line, and says nothing when there are none', async () => {
    vi.mocked(getOwner).mockResolvedValue({ owner: 'acme', others: ['zed', 'yan'] });
    const { unmount } = render(<FirstRun />);
    expect(await screen.findByText('The other owners (zed, yan) get their own app later.')).toBeInTheDocument();
    unmount();

    vi.mocked(getOwner).mockResolvedValue({ owner: 'acme', others: [] });
    render(<FirstRun />);
    await waitFor(() => expect(screen.getByLabelText(/Account that owns the app/)).toHaveValue('acme'));
    expect(screen.queryByText(/other owners/)).not.toBeInTheDocument();
  });

  it('offers no public option', () => {
    render(<FirstRun />);
    expect(screen.queryByText(/public/i)).not.toBeInTheDocument();
  });

  it('puts the token sign-in before the application form in the GitLab card', () => {
    const gitlab = { provider: 'gitlab', base: 'https://git.corp.example', tokenPage: 'https://git.corp.example/t' };
    const setup = {
      provider: 'gitlab',
      page: 'https://git.corp.example/-/user_settings/applications',
      callback: 'https://swarm.example/auth/gitlab/callback',
      scopes: ['read_user', 'api', 'write_repository'],
    };
    render(<FirstRun tokens={[gitlab]} applications={[setup]} />);
    const card = screen.getByRole('region', { name: 'Connect GitLab' });
    const recommended = within(card).getByText('Recommended');
    const token = within(card).getByLabelText('Personal access token');
    const divider = within(card).getByText('Or, for a team that wants OAuth');
    const form = within(card).getByRole('form', { name: 'GitLab application' });
    const before = (a: Element, b: Element): boolean =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(recommended, token)).toBe(true);
    expect(before(token, divider)).toBe(true);
    expect(before(divider, form)).toBe(true);
    expect(within(card).getByText('GitLab at https://git.corp.example')).toBeInTheDocument();
  });

  it('shows no token sign-in when the server offers none', () => {
    render(<FirstRun />);
    expect(screen.queryByLabelText('Personal access token')).not.toBeInTheDocument();
  });
});

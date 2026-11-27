import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { getInstallUrl, getOwner, getProviders, signInWithToken } from '../../lib/endpoints';
import LoginPage from './page';

vi.mock('../../lib/endpoints', () => ({
  getProviders: vi.fn(),
  getInstallUrl: vi.fn(),
  getOwner: vi.fn(),
  signInWithToken: vi.fn(),
  saveApplication: vi.fn(),
}));

const gitlabSetup = {
  provider: 'gitlab',
  page: 'https://git.corp.example/-/user_settings/applications',
  callback: 'https://swarm.example/auth/gitlab/callback',
  scopes: ['read_user', 'api', 'write_repository'],
};

const gitlabToken = {
  provider: 'gitlab',
  base: 'https://git.corp.example',
  tokenPage: 'https://git.corp.example/-/user_settings/personal_access_tokens?name=swarmloop',
};

beforeEach(() => {
  vi.mocked(getProviders).mockReset();
  vi.mocked(signInWithToken).mockReset();
  vi.mocked(getInstallUrl).mockReset().mockResolvedValue({ url: 'https://github.com/apps/x/installations/new' });
  vi.mocked(getOwner).mockReset().mockResolvedValue({ owner: 'acme', others: [] });
  window.history.pushState({}, '', '/login');
});

describe('LoginPage', () => {
  it('shows a button only for the configured provider', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['gitlab'], tokens: [] });

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitLab' })).toHaveAttribute(
      'href',
      '/auth/gitlab/login',
    );
    expect(screen.queryByRole('link', { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it('shows a button for each of two providers', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab'], tokens: [] });

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      '/auth/github/login',
    );
    expect(screen.getByRole('link', { name: 'Continue with GitLab' })).toBeInTheDocument();
  });

  it('says so when no provider is configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], tokens: [], applications: [gitlabSetup] });

    render(<LoginPage />);

    // The no-login mode is gone: with no login yet the page is the first-run screen.
    expect(await screen.findByRole('button', { name: 'Create GitHub App' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it('shows the install step after the app is made, in place of the login buttons', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });
    window.history.pushState({}, '', '/login?install=1');

    render(<LoginPage />);

    expect(await screen.findByText('Install the app on your repositories')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Install the app' })).toHaveAttribute(
      'href',
      'https://github.com/apps/x/installations/new',
    );
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/auth/github/login');
    expect(screen.queryByRole('link', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it('shows where the app was installed and a Log in button', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });
    window.history.pushState({}, '', '/login?installed=acme');

    render(<LoginPage />);

    expect(await screen.findByText('Installed on acme')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/auth/github/login');
  });

  it('shows Installed when the account is empty', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });
    window.history.pushState({}, '', '/login?installed=');

    render(<LoginPage />);

    expect(await screen.findByText('Installed')).toBeInTheDocument();
  });

  it('shows the logo', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });

    const { container } = render(<LoginPage />);

    await screen.findByRole('link', { name: 'Continue with GitHub' });
    expect(container.querySelector('img')).toHaveAttribute('src', '/logo.svg');
  });

  it('shows the mark of each provider, and a neutral mark with the raw name for an unknown one', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab', 'forgejo'], tokens: [] });

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toContainElement(
      screen.getByTestId('mark-github'),
    );
    expect(screen.getByRole('link', { name: 'Continue with GitLab' })).toContainElement(
      screen.getByTestId('mark-gitlab'),
    );
    expect(screen.getByRole('link', { name: 'Continue with forgejo' })).toContainElement(
      screen.getByTestId('mark-neutral'),
    );
  });

  it('shows a skeleton while the providers load', () => {
    vi.mocked(getProviders).mockReturnValue(new Promise(() => undefined));

    const { container } = render(<LoginPage />);

    expect(container.querySelector('.MuiSkeleton-root')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it('loads the providers again on Try again', async () => {
    vi.mocked(getProviders).mockRejectedValueOnce(new Error('api is not reachable'));
    vi.mocked(getProviders).mockResolvedValueOnce({ providers: ['github'], tokens: [] });

    render(<LoginPage />);
    expect(await screen.findByText('api is not reachable')).toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toBeInTheDocument();
  });

  it.each([
    [
      '?error=refused&host=github&account=bob&reason=not%20listed%20in%20SWARMLOOP_ALLOW',
      ["bob can't log in to this server", 'Ask whoever runs this server to add you.'],
    ],
    [
      "?error=refused&host=github&account=bob&reason=can't%20push%20to%20any%20repository%20this%20server%20works%20on",
      [
        "bob can't log in to this server",
        'You need push access to one of the repositories this server works on. Ask whoever runs it.',
      ],
    ],
    ['?error=expired', ['The login took too long or started somewhere else. Try again.']],
    ['?error=host&host=gitlab&reason=timeout', ['Login with GitLab failed: timeout']],
  ])('shows the text of the login problem %s', async (search, texts) => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });
    window.history.pushState({}, '', `/login${search}`);

    render(<LoginPage />);

    for (const text of texts) {
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
  });

  it('links a refusal to the sign-out page of the host', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });
    window.history.pushState({}, '', '/login?error=refused&host=github&account=bob');

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Sign out there' })).toHaveAttribute(
      'href',
      'https://github.com/logout',
    );
  });

  it('shows the first-run form under one heading when no provider is configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], tokens: [] });

    render(<LoginPage />);

    expect(await screen.findByRole('heading', { name: 'Connect swarmloop to your code host' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('Log in to swarmloop')).not.toBeInTheDocument();
    // The form reads the owner after it mounts; the test ends only once that read has landed.
    expect(await screen.findByDisplayValue('acme')).toBeInTheDocument();
  });

  it('shows a login problem above the first-run form when no provider is configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], tokens: [] });
    window.history.pushState({}, '', '/login?error=host&host=github&reason=x');

    render(<LoginPage />);

    await screen.findByRole('heading', { name: 'Connect swarmloop to your code host' });
    expect(await screen.findByText('Login with GitHub failed: x')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await screen.findByDisplayValue('acme')).toBeInTheDocument();
  });

  it('gives the first button focus', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab'], tokens: [] });

    render(<LoginPage />);

    const first = await screen.findByRole('link', { name: 'Continue with GitHub' });
    await waitFor(() => expect(first).toHaveFocus());
  });

  it('passes next on to the button', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });
    window.history.pushState({}, '', '/login?next=%2Fruns%2Fx');

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      '/auth/github/login?next=%2Fruns%2Fx',
    );
  });

  it('offers the token sign-in, once, when no application exists', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], tokens: [gitlabToken] });

    render(<LoginPage />);

    expect(await screen.findByText('GitLab at https://git.corp.example')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Create a token' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Create a token' })).toHaveAttribute('href', gitlabToken.tokenPage);
    expect(screen.getAllByLabelText('Personal access token')).toHaveLength(1);
  });

  it('shows the GitLab token sign-in above Continue with GitLab', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['gitlab'], tokens: [gitlabToken] });

    render(<LoginPage />);

    const button = await screen.findByRole('link', { name: 'Continue with GitLab' });
    const field = screen.getByLabelText('Personal access token');
    expect(field.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with token' })).toBeInTheDocument();
    expect(screen.queryByText('or')).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('shows no Continue button under a token block of a host that is not configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [gitlabToken] });

    render(<LoginPage />);

    await screen.findByLabelText('Personal access token');
    expect(screen.queryByRole('link', { name: 'Continue with GitLab' })).not.toBeInTheDocument();
  });

  it('says the application was rejected, with a link to replace it', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['gitlab'], tokens: [], applications: [gitlabSetup] });
    window.history.pushState({}, '', '/login?error=app&host=gitlab');

    render(<LoginPage />);

    expect(await screen.findByText('GitLab rejected the Application ID or Secret')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Replace the application' })).toHaveAttribute(
      'href',
      '/login?replace=gitlab',
    );
  });

  it('shows the application form in replace mode in place of the choice', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['gitlab'], tokens: [], applications: [gitlabSetup] });
    window.history.pushState({}, '', '/login?replace=gitlab');

    render(<LoginPage />);

    expect(await screen.findByLabelText('Application ID', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace application' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue with GitLab' })).not.toBeInTheDocument();
  });

  it('shows the normal choice when replace names a host with no setup', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['gitlab'], tokens: [], applications: [] });
    window.history.pushState({}, '', '/login?replace=gitlab');

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitLab' })).toBeInTheDocument();
  });

  it('puts an or line between the buttons and a GitLab block with its icon and heading', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [gitlabToken] });

    render(<LoginPage />);

    const button = await screen.findByRole('link', { name: 'Continue with GitHub' });
    const divider = screen.getByText('or');
    const heading = screen.getByRole('heading', { name: 'GitLab' });
    expect(button.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(heading).getByTestId('mark-gitlab')).toBeInTheDocument();
  });

  it('has no or line when no host takes a token', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'], tokens: [] });

    render(<LoginPage />);

    await screen.findByRole('link', { name: 'Continue with GitHub' });
    expect(screen.queryByText('or')).not.toBeInTheDocument();
  });

  it('posts the token and goes to next', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], tokens: [gitlabToken] });
    vi.mocked(signInWithToken).mockResolvedValue({ url: '/runs/x' });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, search: '?next=%2Fruns%2Fx' });

    try {
      render(<LoginPage />);
      const user = userEvent.setup({ delay: null });
      await user.type(await screen.findByLabelText('Personal access token'), ' glpat-abc ');
      await user.click(screen.getByRole('button', { name: 'Sign in with token' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/runs/x'));
      expect(signInWithToken).toHaveBeenCalledWith('gitlab', 'glpat-abc', '/runs/x');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the refusal under the field', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], tokens: [gitlabToken] });
    vi.mocked(signInWithToken).mockRejectedValue(new ApiError(400, 'GitLab did not accept this token'));

    render(<LoginPage />);
    const user = userEvent.setup({ delay: null });
    await user.type(await screen.findByLabelText('Personal access token'), 'glpat-bad{Enter}');

    expect(await screen.findByText('GitLab did not accept this token')).toBeInTheDocument();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstallUrl, getOwner, getProviders } from '../../lib/endpoints';
import LoginPage from './page';

vi.mock('../../lib/endpoints', () => ({ getProviders: vi.fn(), getInstallUrl: vi.fn(), getOwner: vi.fn() }));

beforeEach(() => {
  vi.mocked(getProviders).mockReset();
  vi.mocked(getInstallUrl).mockReset().mockResolvedValue({ url: 'https://github.com/apps/x/installations/new' });
  vi.mocked(getOwner).mockReset().mockResolvedValue({ owner: 'acme', others: [] });
  window.history.pushState({}, '', '/login');
});

describe('LoginPage', () => {
  it('shows a button only for the configured provider', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['gitlab'] });

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitLab' })).toHaveAttribute(
      'href',
      '/auth/gitlab/login',
    );
    expect(screen.queryByRole('link', { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it('shows a button for each of two providers', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab'] });

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      '/auth/github/login',
    );
    expect(screen.getByRole('link', { name: 'Continue with GitLab' })).toBeInTheDocument();
  });

  it('says so when no provider is configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [] });

    render(<LoginPage />);

    // The no-login mode is gone: with no login yet the page is the first-run screen.
    expect(await screen.findByRole('button', { name: 'Create GitHub App' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the install step after the app is made, in place of the login buttons', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });
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
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });
    window.history.pushState({}, '', '/login?installed=acme');

    render(<LoginPage />);

    expect(await screen.findByText('Installed on acme')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/auth/github/login');
  });

  it('shows Installed when the account is empty', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });
    window.history.pushState({}, '', '/login?installed=');

    render(<LoginPage />);

    expect(await screen.findByText('Installed')).toBeInTheDocument();
  });

  it('shows the logo', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });

    const { container } = render(<LoginPage />);

    await screen.findByRole('link', { name: 'Continue with GitHub' });
    expect(container.querySelector('img')).toHaveAttribute('src', '/logo.svg');
  });

  it('shows the mark of each provider, and a neutral mark with the raw name for an unknown one', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab', 'forgejo'] });

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
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('loads the providers again on Try again', async () => {
    vi.mocked(getProviders).mockRejectedValueOnce(new Error('api is not reachable'));
    vi.mocked(getProviders).mockResolvedValueOnce({ providers: ['github'] });

    render(<LoginPage />);
    expect(await screen.findByText('api is not reachable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toBeInTheDocument();
    expect(getProviders).toHaveBeenCalledTimes(2);
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
    ['?error=host&host=gitlab&reason=timeout', ['GitLab did not answer: timeout']],
  ])('shows the text of the login problem %s', async (search, texts) => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });
    window.history.pushState({}, '', `/login${search}`);

    render(<LoginPage />);

    for (const text of texts) {
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
  });

  it('links a refusal to the sign-out page of the host', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });
    window.history.pushState({}, '', '/login?error=refused&host=github&account=bob');

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Sign out there' })).toHaveAttribute(
      'href',
      'https://github.com/logout',
    );
  });

  it('shows the first-run form under one heading when no provider is configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [] });

    render(<LoginPage />);

    expect(await screen.findByRole('heading', { name: 'Connect swarmloop to your code host' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('Log in to swarmloop')).not.toBeInTheDocument();
  });

  it('shows a login problem above the first-run form when no provider is configured', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [] });
    window.history.pushState({}, '', '/login?error=host&host=github&reason=x');

    render(<LoginPage />);

    await screen.findByRole('heading', { name: 'Connect swarmloop to your code host' });
    expect(await screen.findByText('GitHub did not answer: x')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('gives the first button focus', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab'] });

    render(<LoginPage />);

    const first = await screen.findByRole('link', { name: 'Continue with GitHub' });
    await waitFor(() => expect(first).toHaveFocus());
  });

  it('passes next on to the button', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github'] });
    window.history.pushState({}, '', '/login?next=%2Fruns%2Fx');

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      '/auth/github/login?next=%2Fruns%2Fx',
    );
  });
});

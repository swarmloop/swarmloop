import { render, screen } from '@testing-library/react';
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

    expect(await screen.findByRole('link', { name: 'Log in with GitLab' })).toHaveAttribute(
      'href',
      '/auth/gitlab/login',
    );
    expect(screen.queryByRole('link', { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it('shows a button for each of two providers', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: ['github', 'gitlab'] });

    render(<LoginPage />);

    expect(await screen.findByRole('link', { name: 'Log in with GitHub' })).toHaveAttribute(
      'href',
      '/auth/github/login',
    );
    expect(screen.getByRole('link', { name: 'Log in with GitLab' })).toBeInTheDocument();
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
    expect(screen.queryByRole('link', { name: /Log in with/ })).not.toBeInTheDocument();
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
});

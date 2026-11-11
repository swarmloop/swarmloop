import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviders } from '../../lib/endpoints';
import LoginPage from './page';

vi.mock('../../lib/endpoints', () => ({ getProviders: vi.fn() }));

beforeEach(() => {
  vi.mocked(getProviders).mockReset();
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
});

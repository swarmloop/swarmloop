import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, logout } from '../../lib/endpoints';
import { Account } from './account';

vi.mock('../../lib/endpoints', () => ({ getSession: vi.fn(), logout: vi.fn() }));

const assign = vi.fn();

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(logout).mockReset().mockResolvedValue({ ok: true });
  assign.mockReset();
  vi.stubGlobal('location', { assign });
});

describe('Account', () => {
  it('shows the user and logs out to the login page', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', provider: 'github' });

    render(<Account />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /octocat/ }));

    expect(screen.getAllByText('octocat').length).toBeGreaterThan(0);
    expect(screen.getAllByText('github').length).toBeGreaterThan(0);
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });

  it('opens Settings and Connections from the menu', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', provider: 'github' });

    render(<Account />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /octocat/ }));

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('menuitem', { name: 'Connections' })).toHaveAttribute('href', '/connections');
  });

  it('shows initials when the account has no avatar', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', avatarUrl: null });

    render(<Account />);

    expect(await screen.findByText('OC')).toBeInTheDocument();
  });

  it('still shows the button when the session cannot be read', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('offline'));

    render(<Account />);
    await vi.waitFor(() => expect(getSession).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Account/ })).toBeInTheDocument();
  });
});

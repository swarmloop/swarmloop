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
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat' });

    render(<Account />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Logout' }));

    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });

  it('shows nothing without a session', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: null });

    const { container } = render(<Account />);
    await vi.waitFor(() => expect(getSession).toHaveBeenCalled());

    expect(container).toBeEmptyDOMElement();
  });
});

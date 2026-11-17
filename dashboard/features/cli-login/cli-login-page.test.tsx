import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approveCliLogin, getCliLogin } from '../../lib/endpoints';
import { CliLoginPage } from './cli-login-page';

vi.mock('../../lib/endpoints', () => ({ getCliLogin: vi.fn(), approveCliLogin: vi.fn() }));

beforeEach(() => {
  window.history.pushState({}, '', '/cli-login?code=ABCD-1234');
  vi.mocked(getCliLogin).mockReset().mockResolvedValue({ machine: 'build-box', expiresAt: '2026-11-17T10:00:00.000Z' });
  vi.mocked(approveCliLogin).mockReset().mockResolvedValue({});
});

describe('CliLoginPage', () => {
  it('shows the code and approves once', async () => {
    const user = userEvent.setup({ delay: null });
    render(<CliLoginPage />);

    expect(await screen.findByText('Allow the CLI on build-box to act as you?')).toBeInTheDocument();
    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('The CLI is signed in. You can close this page.')).toBeInTheDocument();
    expect(approveCliLogin).toHaveBeenCalledTimes(1);
    expect(approveCliLogin).toHaveBeenCalledWith('ABCD-1234');
  });

  it('shows the error when the login cannot be read', async () => {
    vi.mocked(getCliLogin).mockRejectedValue(new Error('This code has expired'));
    render(<CliLoginPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This code has expired');
  });
});

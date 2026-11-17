import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPeople, setRole } from '../../lib/endpoints';
import { PeopleSection } from './people-section';

vi.mock('../../lib/endpoints', () => ({ listPeople: vi.fn(), setRole: vi.fn() }));

beforeEach(() => {
  vi.mocked(listPeople)
    .mockReset()
    .mockResolvedValue({
      people: [
        { login: 'alice', role: 'admin', createdAt: '2026-11-01T10:00:00.000Z' },
        { login: 'bob', role: 'member', createdAt: '2026-11-02T10:00:00.000Z' },
      ],
    });
  vi.mocked(setRole).mockReset().mockResolvedValue({ login: 'bob', role: 'admin', createdAt: '' });
});

describe('PeopleSection', () => {
  it('lists people with their role and makes a member an admin', async () => {
    const user = userEvent.setup({ delay: null });
    render(<PeopleSection />);

    expect(await screen.findByText('bob')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('bob', 'admin'));
  });

  it('takes the role back only after Confirm', async () => {
    const user = userEvent.setup({ delay: null });
    render(<PeopleSection />);
    await user.click(await screen.findByRole('button', { name: 'Take back admin' }));

    const dialog = await screen.findByRole('dialog');
    expect(setRole).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Take back admin' }));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('alice', 'member'));
  });

  it("shows the server's refusal", async () => {
    vi.mocked(setRole).mockRejectedValue(new Error('One admin must stay'));
    const user = userEvent.setup({ delay: null });
    render(<PeopleSection />);
    await user.click(await screen.findByRole('button', { name: 'Make admin' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('One admin must stay');
  });
});

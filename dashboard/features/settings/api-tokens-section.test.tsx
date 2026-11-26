import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenView } from '@contract/people';
import { createToken, listTokens, revokeToken, useExistingToken } from '../../lib/endpoints';
import { mediaWidth } from '../../test/viewport';
import { ApiTokensSection } from './api-tokens-section';

vi.mock('../../lib/endpoints', () => ({
  listTokens: vi.fn(),
  createToken: vi.fn(),
  useExistingToken: vi.fn(),
  revokeToken: vi.fn(),
}));

const token: TokenView = {
  id: 7,
  name: 'laptop',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
};

beforeEach(() => {
  vi.mocked(listTokens)
    .mockReset()
    .mockResolvedValue({ tokens: [token] });
  vi.mocked(createToken).mockReset();
  vi.mocked(useExistingToken).mockReset().mockResolvedValue({});
  vi.mocked(revokeToken).mockReset().mockResolvedValue({});
});

describe('ApiTokensSection', () => {
  it('shows placeholders, not a table, until the token list arrives', async () => {
    let arrive: (value: { tokens: TokenView[] }) => void = () => undefined;
    vi.mocked(listTokens).mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    render(<ApiTokensSection />);

    expect(screen.getAllByTestId('tokens-placeholder').length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: 'API tokens' })).toBeNull();

    arrive({ tokens: [token] });
    expect(await screen.findByRole('table', { name: 'API tokens' })).toBeInTheDocument();
    expect(screen.queryByTestId('tokens-placeholder')).toBeNull();
  });

  it('lists name, created, last used and expiry', async () => {
    vi.mocked(listTokens).mockResolvedValue({
      tokens: [
        token,
        { ...token, id: 8, name: 'ci', lastUsedAt: '2026-11-02T10:00:00.000Z', expiresAt: '2026-12-01T10:00:00.000Z' },
      ],
    });
    render(<ApiTokensSection />);

    const rows = within(await screen.findByRole('table', { name: 'API tokens' })).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('laptop');
    expect(rows[1]).toHaveTextContent(/never.*never/);
    expect(rows[2]).toHaveTextContent('ci');
    expect(rows[2]).not.toHaveTextContent('never');
  });

  it.each([
    ['30 days', 30],
    ['90 days', 90],
    ['Never', null],
  ])('creates a token for %s, shows the value once, and drops it on close', async (label, days) => {
    vi.mocked(createToken).mockResolvedValue({ ...token, value: 'slp_secret' });
    const user = userEvent.setup({ delay: null });
    render(<ApiTokensSection />);
    const form = await screen.findByRole('form', { name: 'Create token' });

    await user.type(within(form).getByLabelText(/Name/), 'laptop');
    await user.click(within(form).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: label }));
    await user.click(within(form).getByRole('button', { name: 'Create token' }));

    const dialog = await screen.findByRole('dialog');
    expect(createToken).toHaveBeenCalledWith({ name: 'laptop', expiresInDays: days });
    expect(dialog).toHaveTextContent('slp_secret');
    expect(dialog).toHaveTextContent('Copy it now: it will not be shown again.');
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('slp_secret')).not.toBeInTheDocument());
  });

  it('sends the name and value of an existing token', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ApiTokensSection />);
    const form = await screen.findByRole('form', { name: 'Use an existing token' });

    await user.type(within(form).getByLabelText(/Token name/), 'ci');
    await user.type(within(form).getByLabelText(/Token value/), 'slp_abc');
    await user.click(within(form).getByRole('button', { name: 'Use token' }));

    await waitFor(() =>
      expect(useExistingToken).toHaveBeenCalledWith({ name: 'ci', value: 'slp_abc', expiresInDays: null }),
    );
  });

  it('revokes only after Confirm', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ApiTokensSection />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    const dialog = await screen.findByRole('dialog');
    expect(revokeToken).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revokeToken).toHaveBeenCalledWith(7));
  });
});

describe('ApiTokensSection at 375 px', () => {
  mediaWidth(375);

  it('stacks both forms in one column and scrolls the table inside its own box', async () => {
    render(<ApiTokensSection />);
    const table = await screen.findByRole('table', { name: 'API tokens' });

    expect(getComputedStyle(screen.getByTestId('tokens-scroll')).overflowX).toBe('auto');
    expect(screen.getByTestId('tokens-scroll')).toContainElement(table);
    for (const name of ['Create token', 'Use an existing token']) {
      expect(getComputedStyle(screen.getByRole('form', { name })).flexDirection).toBe('column');
    }
    const button = within(screen.getByRole('form', { name: 'Create token' })).getByRole('button');
    expect(getComputedStyle(button.parentElement!).flexWrap).toBe('wrap');
  });
});

describe('ApiTokensSection at 1280 px', () => {
  mediaWidth(1280);

  it('keeps both forms as one row', async () => {
    render(<ApiTokensSection />);
    await screen.findByRole('table', { name: 'API tokens' });

    for (const name of ['Create token', 'Use an existing token']) {
      expect(getComputedStyle(screen.getByRole('form', { name })).flexDirection).not.toBe('column');
    }
  });
});

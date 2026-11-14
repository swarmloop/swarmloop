import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSignIn, saveIntegration, sendSignInCode, startSignIn } from '../../../lib/endpoints';
import { connectionCard, signInView } from '../../../test/fixtures';
import { ConnectionCard } from '../connection-card';
import { FlowDialog } from './flow-dialog';
import { RedirectFlow } from './redirect-flow';
import { SIGN_IN_POLL_MS } from './use-sign-in';

vi.mock('../../../lib/endpoints', () => ({
  saveIntegration: vi.fn(),
  startSignIn: vi.fn(),
  getSignIn: vi.fn(),
  sendSignInCode: vi.fn(),
  testIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
}));

const card = connectionCard();
const [cliFlow, secretFlow] = card.flows;
const formFlow = {
  kind: 'form' as const,
  label: 'Connect Jira',
  helpUrl: 'https://id.atlassian.com/tokens',
  fields: [
    { name: 'url', label: 'Site URL', secret: false },
    { name: 'token', label: 'API token', secret: true },
  ],
};

function open(
  flow: (typeof card.flows)[number],
  onSaved = vi.fn(),
  onClose = vi.fn(),
): { onSaved: () => void; onClose: () => void } {
  render(<FlowDialog card={card} flow={flow} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose };
}

beforeEach(() => {
  vi.mocked(saveIntegration).mockReset();
  vi.mocked(startSignIn).mockReset();
  vi.mocked(getSignIn).mockReset();
  vi.mocked(sendSignInCode).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('flow dialogs', () => {
  it('secret flow saves the pasted key and closes', async () => {
    vi.mocked(saveIntegration).mockResolvedValue(card);
    const { onSaved, onClose } = open(secretFlow);
    const input = screen.getByLabelText('API key');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.type(input, 'sk-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveIntegration).toHaveBeenCalledWith('claude', { apiKey: 'sk-123' });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('form flow sends every named field and shows the token-page link', async () => {
    vi.mocked(saveIntegration).mockResolvedValue(card);
    open(formFlow);
    expect(screen.getByRole('link', { name: /token is made/ })).toHaveAttribute(
      'href',
      'https://id.atlassian.com/tokens',
    );
    await userEvent.type(screen.getByLabelText('Site URL'), 'https://acme.atlassian.net');
    await userEvent.type(screen.getByLabelText('API token'), 'tok');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveIntegration).toHaveBeenCalledWith('claude', { url: 'https://acme.atlassian.net', token: 'tok' });
  });

  it("a failed save shows the provider's message and stays open", async () => {
    vi.mocked(saveIntegration).mockRejectedValue(new Error('Anthropic answered 401'));
    const { onClose } = open(secretFlow);
    await userEvent.type(screen.getByLabelText('API key'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Anthropic answered 401')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('API key')).toHaveValue('bad');
  });

  it('Claude dialog shows the link and the code field and finishes on success', async () => {
    vi.mocked(startSignIn).mockResolvedValue(signInView({ state: 'code', link: 'https://claude.test/auth' }));
    vi.mocked(sendSignInCode).mockResolvedValue(signInView({ state: 'done' }));
    const { onSaved, onClose } = open(cliFlow);

    expect(await screen.findByRole('link', { name: 'Open the sign-in page' })).toHaveAttribute(
      'href',
      'https://claude.test/auth',
    );
    await userEvent.type(screen.getByLabelText('Code'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(sendSignInCode).toHaveBeenCalledWith('claude', 'session-1', 'abc');
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("a failed sign-in shows the provider's message", async () => {
    vi.mocked(startSignIn).mockResolvedValue(signInView({ state: 'failed', message: 'the code was wrong' }));
    open(cliFlow);

    expect(await screen.findByText('the code was wrong')).toBeInTheDocument();
  });

  it('Codex dialog shows the code and link, with progress while it polls', async () => {
    vi.useFakeTimers();
    vi.mocked(startSignIn).mockResolvedValue(
      signInView({ state: 'waiting', code: 'ABCD-1234', link: 'https://chatgpt.test/device' }),
    );
    vi.mocked(getSignIn).mockResolvedValue(signInView({ state: 'waiting', code: 'ABCD-1234' }));
    render(<FlowDialog card={card} flow={{ ...cliFlow, kind: 'device-code' }} onSaved={vi.fn()} onClose={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the sign-in page' })).toHaveAttribute(
      'href',
      'https://chatgpt.test/device',
    );
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS));
    expect(getSignIn).toHaveBeenCalledWith('claude', 'session-1');
  });

  it('it finishes when the poll says done', async () => {
    vi.useFakeTimers();
    vi.mocked(startSignIn).mockResolvedValue(signInView({ state: 'waiting', code: 'ABCD-1234' }));
    vi.mocked(getSignIn).mockResolvedValue(signInView({ state: 'done' }));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<FlowDialog card={card} flow={{ ...cliFlow, kind: 'device-code' }} onSaved={onSaved} onClose={onClose} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS));

    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('one dialog per flow kind', async () => {
    vi.mocked(startSignIn).mockResolvedValue(signInView());
    open(secretFlow);
    expect(screen.getByRole('dialog', { name: 'Paste an API key' })).toBeInTheDocument();
  });

  it('a redirect flow is a link to its url', async () => {
    render(
      <RedirectFlow
        flow={{ kind: 'redirect', label: 'Connect GitHub', fields: [], helpUrl: null, url: '/auth/github/login' }}
        connected={false}
      />,
    );

    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute('href', '/auth/github/login');
  });

  it('Tab reaches Connect and Enter opens the dialog', async () => {
    render(<ConnectionCard card={connectionCard({ flows: [secretFlow] })} onChanged={() => undefined} />);
    await userEvent.tab();

    expect(screen.getByRole('button', { name: 'Connect' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionsView } from '@contract/api';
import type { ConnectionCard } from '@contract/connections';
import {
  disconnect,
  disconnectIntegration,
  getConnections,
  getIntegrationCards,
  getOwner,
  getSession,
  replaceApp,
} from '../../lib/endpoints';
import { connectionCard } from '../../test/fixtures';
import { ConnectionsPage } from './connections-page';

vi.mock('../../lib/endpoints', () => ({
  getConnections: vi.fn(),
  disconnect: vi.fn(),
  getSession: vi.fn(),
  replaceApp: vi.fn(),
  getOwner: vi.fn(),
  getIntegrationCards: vi.fn(),
  disconnectIntegration: vi.fn(),
  saveIntegration: vi.fn(),
  testIntegration: vi.fn(),
  startSignIn: vi.fn(),
  getSignIn: vi.fn(),
  sendSignInCode: vi.fn(),
  installMore: vi.fn(),
  reconnectUrl: (host: string) => `/auth/${host}/login`,
}));

const connected: ConnectionsView = {
  connections: [
    {
      host: 'github',
      appLabel: 'App',
      installs: true,
      app: {
        name: 'swarmloop-app',
        clientId: 'Iv.fake',
        madeBy: 'alice',
        settingsUrl: 'https://github.com/settings/apps/swarmloop-app',
      },
      missingOwners: [],
      account: 'alice',
      repositories: ['alice/site', 'acme/api'],
      selection: 'selected',
      health: { status: 'ok', expiresAt: '2026-11-08T21:50:00.000Z', refreshedAt: '2026-11-08T13:50:00.000Z' },
    },
    {
      host: 'gitlab',
      appLabel: 'Application',
      installs: false,
      app: null,
      account: null,
      repositories: [],
      selection: null,
      health: null,
    },
  ],
};

const redirect = { kind: 'redirect' as const, label: 'Connect', fields: [], helpUrl: null };
const cards: ConnectionCard[] = [
  connectionCard({
    id: 'github',
    logo: 'github',
    label: 'GitHub',
    flows: [{ ...redirect, url: '/auth/github/login' }],
  }),
  connectionCard({
    id: 'gitlab',
    logo: 'gitlab',
    label: 'GitLab',
    flows: [{ ...redirect, url: '/auth/gitlab/login' }],
  }),
  connectionCard(),
];

beforeEach(() => {
  vi.mocked(getIntegrationCards).mockReset().mockResolvedValue({ cards });
  vi.mocked(disconnectIntegration).mockReset();
  window.location.hash = '';
  vi.mocked(getConnections).mockReset();
  vi.mocked(disconnect).mockReset();
  vi.mocked(replaceApp).mockReset();
  vi.mocked(getOwner).mockReset().mockResolvedValue({ owner: 'acme', others: [] });
  vi.mocked(getSession).mockReset().mockResolvedValue({ user: 'alice' });
});

describe('ConnectionsPage', () => {
  it('shows the account, the repositories and the health of the token', async () => {
    vi.mocked(getConnections).mockResolvedValue(connected);
    render(<ConnectionsPage />);

    const github = await screen.findByRole('region', { name: 'GitHub' });
    expect(github).toHaveTextContent('Signed in as alice');
    expect(github).toHaveTextContent('swarmloop-app');
    expect(github).toHaveTextContent('connected');
    expect(github).toHaveTextContent('Token expires');
    expect(github).toHaveTextContent('refreshed');
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install on more repositories' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', '/auth/github/login');
    expect(screen.getByRole('region', { name: 'GitLab' })).toHaveTextContent('not connected');
  });

  it('asks once before Disconnect and then shows the host as cleared', async () => {
    vi.mocked(getConnections).mockResolvedValueOnce(connected);
    vi.mocked(disconnect).mockResolvedValue({ ok: true });
    render(<ConnectionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    expect(disconnect).not.toHaveBeenCalled();
    vi.mocked(getConnections).mockResolvedValue({
      connections: connected.connections.map((item) => ({ ...item, account: null, repositories: [], health: null })),
    });
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith('github');
    await waitFor(() => expect(screen.queryByText('Signed in as alice')).not.toBeInTheDocument());
    expect(screen.getAllByText('not connected')).toHaveLength(2);
  });

  it('disables Replace app for a person who did not make the app, and says who can', async () => {
    vi.mocked(getConnections).mockResolvedValue(connected);
    vi.mocked(getSession).mockResolvedValue({ user: 'bob' });
    render(<ConnectionsPage />);

    expect(await screen.findByRole('button', { name: 'Replace app' })).toBeDisabled();
    expect(screen.getByText('Only alice can replace this app')).toBeInTheDocument();
  });

  it('confirms with the app name and its GitHub settings, then shows the first-run form', async () => {
    const withPeople = (people: string[]): ConnectionsView => ({
      connections: connected.connections.map((item) =>
        item.host === 'github' ? { ...item, connected: people } : item,
      ),
    });
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    vi.mocked(getConnections).mockResolvedValue(withPeople(['alice', 'bob']));
    vi.mocked(replaceApp).mockResolvedValue({ action: 'https://github.com/settings/apps/new', manifest: { a: 1 } });
    const { unmount } = render(<ConnectionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Replace app' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Replace swarmloop-app?');
    expect(dialog).toHaveTextContent('alice, bob will be disconnected.');
    expect(dialog).toHaveTextContent('Their runs wait with GIT_AUTH until they log in again.');
    expect(dialog).toHaveTextContent('The app on GitHub stays');
    expect(within(dialog).getByRole('link', { name: 'GitHub settings' })).toHaveAttribute(
      'href',
      'https://github.com/settings/apps/swarmloop-app',
    );
    expect(replaceApp).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace app' }));

    await waitFor(() => expect(replaceApp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(document.querySelector('form')).toHaveAttribute('action', 'https://github.com/settings/apps/new');
    expect(document.querySelector('input[name="manifest"]')).toHaveValue('{"a":1}');
    unmount();

    vi.mocked(getConnections).mockResolvedValue(withPeople(['a', 'b', 'c', 'd', 'e', 'f']));
    render(<ConnectionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Replace app' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('6 people will be disconnected.');
    submit.mockRestore();
  });

  it('warns about the owners the installation misses, and only then', async () => {
    const withMissing = {
      connections: connected.connections.map((item) =>
        item.host === 'github' ? { ...item, missingOwners: ['acme', 'zed'] } : item,
      ),
    };
    vi.mocked(getConnections).mockResolvedValueOnce(withMissing);
    const { unmount } = render(<ConnectionsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('acme, zed');
    unmount();

    vi.mocked(getConnections).mockResolvedValue(connected);
    render(<ConnectionsPage />);
    await screen.findByRole('region', { name: 'GitHub' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the Claude card draws from the card list and Disconnect clears it after the reload', async () => {
    vi.mocked(getConnections).mockResolvedValue(connected);
    vi.mocked(getIntegrationCards).mockResolvedValue({
      cards: cards.map((card) =>
        card.id === 'claude' ? connectionCard({ status: 'connected', account: 'alice@acme.test' }) : card,
      ),
    });
    vi.mocked(disconnectIntegration).mockResolvedValue({ ok: true });
    render(<ConnectionsPage />);
    const claude = await screen.findByRole('region', { name: 'Claude' });
    expect(claude).toHaveTextContent('Connected as alice@acme.test');

    vi.mocked(getIntegrationCards).mockResolvedValue({ cards });
    await userEvent.click(within(claude).getByRole('button', { name: 'Disconnect' }));

    expect(disconnectIntegration).toHaveBeenCalledWith('claude');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Claude' })).toHaveTextContent('Not connected'));
  });

  it('the hash #claude focuses the Claude card', async () => {
    vi.mocked(getConnections).mockResolvedValue(connected);
    window.location.hash = '#claude';
    render(<ConnectionsPage />);

    await waitFor(() => expect(screen.getByRole('region', { name: 'Claude' })).toHaveFocus());
  });

  it('GitHub and GitLab appear once', async () => {
    vi.mocked(getConnections).mockResolvedValue(connected);
    render(<ConnectionsPage />);
    await screen.findByRole('region', { name: 'Claude' });

    expect(screen.getAllByRole('region', { name: 'GitHub' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'GitLab' })).toHaveLength(1);
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionsView } from '@contract/api';
import { disconnect, getConnections, getOwner, getSession, replaceApp } from '../../lib/endpoints';
import { ConnectionsPage } from './connections-page';

vi.mock('../../lib/endpoints', () => ({
  getConnections: vi.fn(),
  disconnect: vi.fn(),
  getSession: vi.fn(),
  replaceApp: vi.fn(),
  getOwner: vi.fn(),
  installMore: vi.fn(),
  reconnectUrl: (host: string) => `/auth/${host}/login`,
}));

const connected: ConnectionsView = {
  connections: [
    {
      host: 'github',
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
    { host: 'gitlab', app: null, account: null, repositories: [], selection: null, health: null },
  ],
};

beforeEach(() => {
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
    vi.mocked(getConnections).mockResolvedValueOnce(connected);
    vi.mocked(replaceApp).mockResolvedValue({ ok: true });
    render(<ConnectionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Replace app' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Replace swarmloop-app?');
    expect(within(dialog).getByRole('link', { name: 'GitHub settings' })).toHaveAttribute(
      'href',
      'https://github.com/settings/apps/swarmloop-app',
    );
    expect(replaceApp).not.toHaveBeenCalled();
    vi.mocked(getConnections).mockResolvedValue({
      connections: connected.connections.map((item) => ({ ...item, app: null, account: null, health: null })),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace app' }));

    await waitFor(() => expect(replaceApp).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Create GitHub App' })).toBeInTheDocument();
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
});

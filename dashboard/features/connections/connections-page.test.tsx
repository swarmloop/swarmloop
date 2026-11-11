import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionsView } from '@contract/api';
import { disconnect, getConnections } from '../../lib/endpoints';
import { ConnectionsPage } from './connections-page';

vi.mock('../../lib/endpoints', () => ({
  getConnections: vi.fn(),
  disconnect: vi.fn(),
  installMore: vi.fn(),
  reconnectUrl: (host: string) => `/auth/${host}/login`,
}));

const connected: ConnectionsView = {
  connections: [
    {
      host: 'github',
      app: { name: 'swarmloop-app', clientId: 'Iv.fake' },
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
});

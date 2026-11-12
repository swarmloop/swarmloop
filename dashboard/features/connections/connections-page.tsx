'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ConnectionView } from '@contract/api';
import { disconnect, getConnections, getSession, installMore, reconnectUrl, replaceApp } from '../../lib/endpoints';
import { FirstRun } from './first-run';
import { localTime } from '../../lib/format';

const NAMES = { github: 'GitHub', gitlab: 'GitLab' } as const;

/** Per host: the app, the connected account, the repositories, the health of the token, and Reconnect and Disconnect. */
export function ConnectionsPage(): ReactElement {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<ConnectionView | null>(null);
  const [replacing, setReplacing] = useState<ConnectionView | null>(null);
  const [login, setLogin] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([getConnections(), getSession()]).then(
      ([view, me]) => {
        setConnections(view.connections);
        setLogin(me.user);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'connections could not be read'),
    );
  }, []);
  useEffect(load, [load]);

  async function addRepositories(host: string): Promise<void> {
    try {
      window.location.assign((await installMore(host)).url);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the install page could not be opened');
    }
  }

  async function confirmDisconnect(): Promise<void> {
    if (!asking) {
      return;
    }
    const host = asking.host;
    setAsking(null);
    try {
      await disconnect(host);
      load();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'disconnect failed');
    }
  }

  async function confirmReplace(): Promise<void> {
    setReplacing(null);
    try {
      await replaceApp();
      load();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the app could not be replaced');
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 900 }}>
      <Box>
        <Typography variant="h5" component="h1">
          Connections
        </Typography>
        <Typography color="text.secondary">
          Each run uses the access of the person who started it. Nothing here shows a token.
        </Typography>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {(connections ?? []).map((connection) =>
        connection.host === 'github' && connection.app === null ? (
          <FirstRun key={connection.host} />
        ) : (
          <HostCard
            key={connection.host}
            connection={connection}
            login={login}
            onReplace={() => setReplacing(connection)}
            onInstall={() => void addRepositories(connection.host)}
            onDisconnect={() => setAsking(connection)}
          />
        ),
      )}
      <Dialog open={replacing !== null} onClose={() => setReplacing(null)} aria-labelledby="replace-title">
        <DialogTitle id="replace-title">Replace {replacing?.app?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The app is forgotten here and the first-run form opens again. The app on GitHub stays
            {replacing?.app?.settingsUrl ? (
              <>
                {' '}
                (delete it in its{' '}
                <Link href={replacing.app.settingsUrl} target="_blank" rel="noopener noreferrer">
                  GitHub settings
                </Link>
                )
              </>
            ) : null}
            .
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReplacing(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void confirmReplace()}>
            Replace app
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={asking !== null} onClose={() => setAsking(null)} aria-labelledby="disconnect-title">
        <DialogTitle id="disconnect-title">Disconnect {asking ? NAMES[asking.host] : ''}?</DialogTitle>
        <DialogContent>
          <DialogContentText>The stored tokens are deleted. Your runs wait until you connect again.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAsking(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void confirmDisconnect()}>
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function HostCard({
  connection,
  login,
  onReplace,
  onInstall,
  onDisconnect,
}: {
  connection: ConnectionView;
  login: string | null;
  onReplace: () => void;
  onInstall: () => void;
  onDisconnect: () => void;
}): ReactElement {
  const name = NAMES[connection.host];
  const { health } = connection;
  const maker = login !== null && connection.app?.madeBy === login;
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={name}
      sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
          {name}
        </Typography>
        {health ? (
          <Chip
            size="small"
            color={health.status === 'ok' ? 'success' : 'error'}
            label={health.status === 'ok' ? 'connected' : 'needs reconnect'}
          />
        ) : (
          <Chip size="small" label="not connected" />
        )}
      </Box>
      <Typography variant="body2" color="text.secondary">
        {connection.app
          ? `${connection.host === 'github' ? 'App' : 'Application'} ${connection.app.name} · ${connection.app.clientId}`
          : 'No app or application is set up yet.'}
      </Typography>
      {connection.missingOwners?.length ? (
        <Alert severity="warning">
          The installation covers none of this server's repositories. Missing owners:{' '}
          {connection.missingOwners.join(', ')}. Use Install on more repositories.
        </Alert>
      ) : null}
      {connection.account ? <Typography>Signed in as {connection.account}</Typography> : null}
      {health ? (
        <Typography variant="body2" color="text.secondary">
          {health.expiresAt ? `Token expires ${localTime(health.expiresAt)}` : 'Token does not expire'}
          {health.refreshedAt ? ` · refreshed ${localTime(health.refreshedAt)}` : ''}
        </Typography>
      ) : null}
      {connection.host === 'github' && connection.app && !maker ? (
        <Typography variant="body2" color="text.secondary">
          {connection.app.madeBy
            ? `Only ${connection.app.madeBy} can replace this app`
            : 'Only the person who made this app can replace it, and it has no recorded maker'}
        </Typography>
      ) : null}
      {connection.host === 'github' && connection.account ? (
        <Box component="section" aria-label="Repositories">
          <Typography variant="subtitle2">
            Repositories ({connection.selection === 'all' ? 'all of them' : 'selected'})
          </Typography>
          {connection.repositories.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              None yet.
            </Typography>
          ) : (
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {connection.repositories.map((repository) => (
                <li key={repository}>{repository}</li>
              ))}
            </Box>
          )}
        </Box>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
        {connection.host === 'github' && connection.account ? (
          <Button variant="outlined" size="small" onClick={onInstall}>
            Install on more repositories
          </Button>
        ) : null}
        {connection.app ? (
          <Button variant="outlined" size="small" component={Link} href={reconnectUrl(connection.host)}>
            {connection.account ? 'Reconnect' : `Connect ${name}`}
          </Button>
        ) : null}
        {connection.host === 'github' && connection.app ? (
          <Button variant="outlined" size="small" disabled={!maker} onClick={onReplace}>
            Replace app
          </Button>
        ) : null}
        {connection.account ? (
          <Button variant="outlined" size="small" color="error" onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : null}
      </Box>
    </Paper>
  );
}

'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { ConnectionView } from '@contract/api';
import { disconnect, getConnections, getSession, installMore, replaceApp } from '../../lib/endpoints';
import { FirstRun, ManifestPost, type ManifestForm } from './first-run';
import { HostCard, NAMES } from './host-card';

const NAMED_MAX = 5;

/** Who the replace disconnects: by name when there are few, else the count. */
function disconnected(people: string[]): string {
  if (people.length === 0) {
    return 'Everyone connected through this app';
  }
  return people.length <= NAMED_MAX ? people.join(', ') : `${people.length} people`;
}

/** Per host: the app, the connected account, the repositories, the health of the token, and Reconnect and Disconnect. */
export function ConnectionsPage(): ReactElement {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<ConnectionView | null>(null);
  const [replacing, setReplacing] = useState<ConnectionView | null>(null);
  const [form, setForm] = useState<ManifestForm | null>(null);
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
      setForm(await replaceApp());
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
      {form ? <ManifestPost key={form.action} form={form} /> : null}
      <Dialog open={replacing !== null} onClose={() => setReplacing(null)} aria-labelledby="replace-title">
        <DialogTitle id="replace-title">Replace {replacing?.app?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {disconnected(replacing?.connected ?? [])} will be disconnected. Their runs wait with GIT_AUTH until they
            log in again. The app on GitHub stays
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

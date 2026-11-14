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
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { ConnectionView } from '@contract/api';
import type { ConnectionCard as Card } from '@contract/connections';
import {
  disconnect,
  getConnections,
  getIntegrationCards,
  getSession,
  installMore,
  replaceApp,
} from '../../lib/endpoints';
import { ConnectionCard } from './connection-card';
import { FirstRun, ManifestPost, type ManifestForm } from './first-run';
import { HostCard } from './host-card';

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
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ connection: ConnectionView; label: string } | null>(null);
  const [replacing, setReplacing] = useState<ConnectionView | null>(null);
  const [form, setForm] = useState<ManifestForm | null>(null);
  const [login, setLogin] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([getConnections(), getIntegrationCards(), getSession()]).then(
      ([view, integrations, me]) => {
        setConnections(view.connections);
        setCards(integrations.cards);
        setLogin(me.user);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'connections could not be read'),
    );
  }, []);
  useEffect(load, [load]);
  const loaded = connections !== null;
  useEffect(() => {
    const target = loaded ? document.getElementById(window.location.hash.slice(1)) : null;
    target?.scrollIntoView?.();
    target?.focus();
  }, [loaded]);

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
    const host = asking.connection.host;
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
          Connect the services your runs use. Each run uses the access of the person who started it, and nothing here
          shows a secret again.
        </Typography>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Grid container spacing={2}>
        {cards.map((card) => {
          const connection = (connections ?? []).find((item) => item.host === card.id);
          return (
            <Grid key={card.id} size={connection?.installs && connection.app === null ? 12 : { xs: 12, md: 6 }}>
              {connection?.installs && connection.app === null ? (
                <FirstRun />
              ) : connection ? (
                <HostCard
                  card={card}
                  connection={connection}
                  login={login}
                  onChanged={load}
                  onReplace={() => setReplacing(connection)}
                  onInstall={() => void addRepositories(connection.host)}
                  onDisconnect={() => setAsking({ connection, label: card.label })}
                />
              ) : (
                <ConnectionCard card={card} onChanged={load} />
              )}
            </Grid>
          );
        })}
      </Grid>
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
        <DialogTitle id="disconnect-title">Disconnect {asking?.label}?</DialogTitle>
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

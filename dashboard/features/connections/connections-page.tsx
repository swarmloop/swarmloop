'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { ConnectionView } from '@contract/api';
import type { ConnectionCard as Card } from '@contract/connections';
import { disconnect, getConnections, getIntegrationCards, installMore, replaceApp } from '../../lib/endpoints';
import { ConfirmDialog } from '../shell';
import { ConnectionCard } from './connection-card';
import { FirstRun, ManifestPost, type ManifestForm } from './first-run';
import { HostCard } from './host-card';
import { hostTexts } from './logos';

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
  const words = replacing ? hostTexts(replacing.host)?.replace : undefined;
  const [form, setForm] = useState<ManifestForm | null>(null);

  const load = useCallback(() => {
    Promise.all([getConnections(), getIntegrationCards()]).then(
      ([view, integrations]) => {
        setConnections(view.connections);
        setCards(integrations.cards);
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
    if (asking) {
      await disconnect(asking.connection.host);
      load();
    }
  }

  async function confirmReplace(): Promise<void> {
    setForm(await replaceApp());
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
      <ConfirmDialog
        open={replacing !== null}
        title={`Replace ${replacing?.app?.name}?`}
        body={
          <>
            {disconnected(replacing?.connected ?? [])} will be disconnected. Their runs wait with GIT_AUTH until they
            log in again. {words?.stays}
            {replacing?.app?.settingsUrl ? (
              <>
                {' '}
                (delete it in its{' '}
                <Link href={replacing.app.settingsUrl} target="_blank" rel="noopener noreferrer">
                  {words?.settings}
                </Link>
                )
              </>
            ) : null}
            .
          </>
        }
        verb="Replace app"
        tone="danger"
        onConfirm={confirmReplace}
        onClose={() => setReplacing(null)}
      />
      <ConfirmDialog
        open={asking !== null}
        title={`Disconnect ${asking?.label}?`}
        body="The stored tokens are deleted. Your runs wait until you connect again."
        verb="Disconnect"
        tone="danger"
        onConfirm={confirmDisconnect}
        onClose={() => setAsking(null)}
      />
    </Box>
  );
}

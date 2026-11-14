'use client';

import type { ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ConnectionView } from '@contract/api';
import type { ConnectionCard } from '@contract/connections';
import { reconnectUrl } from '../../lib/endpoints';
import { localTime } from '../../lib/format';
import { CardHeading } from './card-heading';
import { useCardActions } from './use-card-actions';

type Handlers = { onReplace: () => void; onInstall: () => void; onDisconnect: () => void };

function HealthChip({ health }: { health: ConnectionView['health'] }): ReactElement {
  if (!health) {
    return <Chip size="small" label="not connected" />;
  }
  return (
    <Chip
      size="small"
      color={health.status === 'ok' ? 'success' : 'error'}
      label={health.status === 'ok' ? 'connected' : 'needs reconnect'}
    />
  );
}

function RepositoryList({ connection }: { connection: ConnectionView }): ReactElement {
  return (
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
  );
}

function HostActions({
  card,
  connection,
  maker,
  onReplace,
  onInstall,
  onDisconnect,
  onTest,
}: Handlers & { card: ConnectionCard; connection: ConnectionView; maker: boolean; onTest: () => void }): ReactElement {
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
      {connection.installs && connection.account ? (
        <Button variant="outlined" size="small" onClick={onInstall}>
          Install on more repositories
        </Button>
      ) : null}
      {connection.app ? (
        <Button variant="outlined" size="small" component={Link} href={reconnectUrl(connection.host)}>
          {connection.account ? 'Reconnect' : `Connect ${card.label}`}
        </Button>
      ) : null}
      {connection.installs && connection.app ? (
        <Button variant="outlined" size="small" disabled={!maker} onClick={onReplace}>
          Replace app
        </Button>
      ) : null}
      {connection.account || card.serverDefault ? (
        <Button variant="outlined" size="small" onClick={onTest}>
          Test
        </Button>
      ) : null}
      {connection.account ? (
        <Button variant="outlined" size="small" color="error" onClick={onDisconnect}>
          Disconnect
        </Button>
      ) : null}
    </Box>
  );
}

/** A code host: the card of its description, with the app, the account, the repositories and the token health of its own login. */
export function HostCard({
  card,
  connection,
  login,
  onChanged,
  ...handlers
}: Handlers & {
  card: ConnectionCard;
  connection: ConnectionView;
  login: string | null;
  onChanged: () => void;
}): ReactElement {
  const { health } = connection;
  const maker = login !== null && connection.app?.madeBy === login;
  const { result, test } = useCardActions(card, onChanged);
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={card.label}
      sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <CardHeading card={card}>
        <HealthChip health={health} />
      </CardHeading>
      <Typography variant="body2" color="text.secondary">
        {connection.app
          ? `${connection.appLabel} ${connection.app.name} · ${connection.app.clientId}`
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
      {connection.installs && connection.app && !maker ? (
        <Typography variant="body2" color="text.secondary">
          {connection.app.madeBy
            ? `Only ${connection.app.madeBy} can replace this app`
            : 'Only the person who made this app can replace it, and it has no recorded maker'}
        </Typography>
      ) : null}
      {connection.installs && connection.account ? <RepositoryList connection={connection} /> : null}
      {result ? <Alert severity={result.severity}>{result.text}</Alert> : null}
      <HostActions card={card} connection={connection} maker={maker} onTest={() => void test()} {...handlers} />
    </Paper>
  );
}

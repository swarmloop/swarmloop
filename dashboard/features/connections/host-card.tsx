'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ConnectionView, TokenSignInView } from '@contract/api';
import { personLabel } from '@contract/people';
import type { ConnectionCard } from '@contract/connections';
import { reconnectUrl } from '../../lib/endpoints';
import { localTime } from '../../lib/format';
import { CardHeading } from './card-heading';
import { TokenSignIn } from './token-sign-in';
import { useCardActions } from './use-card-actions';

/** The page the person is on, so a token sign-in comes back to it. */
function currentPage(): string {
  return window.location.pathname + window.location.search;
}

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
  const [open, setOpen] = useState(false);
  const count = connection.repositories.length;
  return (
    <Box component="section" aria-label="Repositories">
      <Typography variant="subtitle2">
        {count} repositories ({connection.selection === 'all' ? 'all of them' : 'selected'})
      </Typography>
      {count === 0 ? (
        <Typography variant="body2" color="text.secondary">
          None yet.
        </Typography>
      ) : (
        <>
          <Button size="small" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'}
          </Button>
          {open ? (
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {connection.repositories.map((repository) => (
                <li key={repository}>{repository}</li>
              ))}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

function HostActions({
  card,
  connection,
  onReplace,
  onInstall,
  onDisconnect,
  onTest,
}: Handlers & { card: ConnectionCard; connection: ConnectionView; onTest: () => void }): ReactElement {
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
      {connection.app && connection.mayReplace ? (
        <Button variant="outlined" size="small" onClick={onReplace}>
          Replace {connection.appLabel.toLowerCase()}
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
  onChanged,
  tokenEntry,
  ...handlers
}: Handlers & {
  card: ConnectionCard;
  connection: ConnectionView;
  onChanged: () => void;
  tokenEntry?: TokenSignInView;
}): ReactElement {
  const { health } = connection;
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
      {!connection.app && !connection.account && tokenEntry ? (
        <TokenSignIn entry={tokenEntry} label={card.label} next={currentPage()} />
      ) : (
        <Typography variant="body2" color="text.secondary">
          {connection.app ? `${connection.appLabel} ${connection.app.name}` : 'No app or application is set up yet.'}
        </Typography>
      )}
      {connection.unreachable?.length ? (
        <Alert severity="warning">
          A run cannot reach these repositories through the installation or the server's token:{' '}
          {connection.unreachable.join(', ')}. Use Install on more repositories.
        </Alert>
      ) : null}
      {connection.account ? <Typography>Signed in as {connection.account}</Typography> : null}
      {health ? (
        <Typography variant="body2" color="text.secondary">
          {health.expiresAt ? `Token expires ${localTime(health.expiresAt)}` : 'Token does not expire'}
          {health.refreshedAt ? ` · refreshed ${localTime(health.refreshedAt)}` : ''}
        </Typography>
      ) : null}
      {connection.installs && connection.app && !connection.mayReplace ? (
        <Typography variant="body2" color="text.secondary">
          {connection.app.madeBy
            ? `Only ${personLabel(connection.app.madeBy)} or an admin can replace this app`
            : 'Only an admin can replace this app'}
        </Typography>
      ) : null}
      {connection.installs && connection.account ? <RepositoryList connection={connection} /> : null}
      {result ? <Alert severity={result.severity}>{result.text}</Alert> : null}
      <HostActions card={card} connection={connection} onTest={() => void test()} {...handlers} />
    </Paper>
  );
}

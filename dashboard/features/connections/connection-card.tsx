'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ConnectionCard as Card, ConnectionFlow } from '@contract/connections';
import { paidUseUnseenNote } from '@contract/paid-use';
import { ConfirmDialog } from '../shell';
import { CardHeading } from './card-heading';
import { FlowDialog } from './flows/flow-dialog';
import { RedirectFlow } from './flows/redirect-flow';
import { useCardActions } from './use-card-actions';

/** The status in words: who is connected, nothing yet, or what needs attention. */
function statusLine(card: Card): string {
  switch (card.status) {
    case 'connected':
      if (card.account !== null) {
        return `Runs use your ${card.account}`;
      }
      return card.last4 ? `Runs use your key ending in ${card.last4}` : "Runs use the server's key";
    case 'attention':
      return `Needs attention: ${card.reason ?? 'the connection does not work'}`;
    case 'not-connected':
      return 'Not connected';
  }
}

/**
 * Whether the person stored a credential of their own. A card with an account or the last four characters of a secret
 * has one; a card with neither is the server default alone, which Test can check and Disconnect cannot remove.
 */
function hasOwnCredential(card: Card): boolean {
  return card.account !== null || card.last4 !== null;
}

/** One integration, drawn from its description alone: logo, purpose, status, and its flows. */
export function ConnectionCard({ card, onChanged }: { card: Card; onChanged: () => void }): ReactElement {
  const [flow, setFlow] = useState<ConnectionFlow | null>(null);
  const [asking, setAsking] = useState(false);
  const { result, test, remove } = useCardActions(card, onChanged);
  const connected = card.status !== 'not-connected';
  const single = card.flows.length === 1;

  return (
    <Paper
      variant="outlined"
      component="section"
      id={card.id}
      aria-label={card.label}
      tabIndex={-1}
      sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%', outline: 'none' }}
    >
      <CardHeading card={card} />
      <Typography color={card.status === 'attention' ? 'error.main' : 'text.primary'}>
        {statusLine(card)}
        {card.account !== null && card.last4 ? ` · ends in ${card.last4}` : ''}
      </Typography>
      {card.paidUseUnseen ? (
        <Typography variant="body2" color="text.secondary">
          {paidUseUnseenNote(card.label)}
        </Typography>
      ) : null}
      {result ? <Alert severity={result.severity}>{result.text}</Alert> : null}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 'auto' }}>
        {card.flows.map((item) =>
          item.kind === 'redirect' ? (
            <RedirectFlow key={item.kind + item.label} flow={item} connected={connected} />
          ) : (
            <Button key={item.kind + item.label} variant="contained" size="small" onClick={() => setFlow(item)}>
              {single ? 'Connect' : item.label}
            </Button>
          ),
        )}
        {connected ? (
          <Button variant="outlined" size="small" onClick={() => void test()}>
            Test
          </Button>
        ) : null}
        {hasOwnCredential(card) ? (
          <Button variant="outlined" size="small" color="error" onClick={() => setAsking(true)}>
            Disconnect
          </Button>
        ) : null}
      </Box>
      <ConfirmDialog
        open={asking}
        title={`Disconnect ${card.label}?`}
        body="The stored credential is deleted. Your runs that use it wait until you connect again."
        verb="Disconnect"
        tone="danger"
        onConfirm={remove}
        onClose={() => setAsking(false)}
      />
      {flow ? <FlowDialog card={card} flow={flow} onClose={() => setFlow(null)} onSaved={onChanged} /> : null}
    </Paper>
  );
}

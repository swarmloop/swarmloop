'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ConnectionCard as Card, ConnectionFlow } from '@contract/connections';
import { disconnectIntegration, testIntegration } from '../../lib/endpoints';
import { FlowDialog } from './flows/flow-dialog';
import { messageOf } from './flows/flow-types';
import { RedirectFlow } from './flows/redirect-flow';
import { logoFor } from './logos';

/** The status in words: who is connected, nothing yet, or what needs attention. */
function statusLine(card: Card): string {
  switch (card.status) {
    case 'connected':
      return `Connected as ${card.account ?? 'this account'}`;
    case 'attention':
      return `Needs attention: ${card.reason ?? 'the connection does not work'}`;
    case 'not-connected':
      return 'Not connected';
  }
}

/** One integration, drawn from its description alone: logo, purpose, status, and its flows. */
export function ConnectionCard({ card, onChanged }: { card: Card; onChanged: () => void }): ReactElement {
  const [flow, setFlow] = useState<ConnectionFlow | null>(null);
  const [result, setResult] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const Logo = logoFor(card.logo);
  const connected = card.status !== 'not-connected';
  const single = card.flows.length === 1;

  async function run(action: () => Promise<unknown>, fallback: string): Promise<void> {
    try {
      await action();
    } catch (cause: unknown) {
      setResult({ severity: 'error', text: messageOf(cause, fallback) });
    }
  }

  async function test(): Promise<void> {
    setResult(null);
    await run(async () => {
      const tested = await testIntegration(card.id);
      setResult(
        tested.status === 'attention'
          ? { severity: 'error', text: tested.reason ?? 'the test failed' }
          : { severity: 'success', text: 'Test passed' },
      );
      onChanged();
    }, 'the test could not run');
  }

  async function remove(): Promise<void> {
    setResult(null);
    await run(async () => {
      await disconnectIntegration(card.id);
      onChanged();
    }, 'the disconnect failed');
  }

  return (
    <Paper
      variant="outlined"
      component="section"
      id={card.id}
      aria-label={card.label}
      tabIndex={-1}
      sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%', outline: 'none' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Logo sx={{ color: 'text.secondary' }} />
        <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
          {card.label}
        </Typography>
        {card.serverDefault ? <Chip size="small" label="Server default" /> : null}
      </Box>
      <Typography variant="body2" color="text.secondary">
        {card.purpose}
      </Typography>
      <Typography color={card.status === 'attention' ? 'error.main' : 'text.primary'}>
        {statusLine(card)}
        {card.last4 ? ` · ends in ${card.last4}` : ''}
      </Typography>
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
          <>
            <Button variant="outlined" size="small" onClick={() => void test()}>
              Test
            </Button>
            <Button variant="outlined" size="small" color="error" onClick={() => void remove()}>
              Disconnect
            </Button>
          </>
        ) : null}
      </Box>
      {flow ? <FlowDialog card={card} flow={flow} onClose={() => setFlow(null)} onSaved={onChanged} /> : null}
    </Paper>
  );
}

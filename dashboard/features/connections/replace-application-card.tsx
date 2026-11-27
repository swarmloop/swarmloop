'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { ConnectionView } from '@contract/api';
import type { ApplicationSetupView } from '@contract/host-login';
import type { ConnectionCard } from '@contract/connections';
import { ApplicationForm } from './application-form';
import { hostTexts } from './logos';

/** The card of a host in its place while its stored application is being replaced. */
export function ReplaceApplicationCard({
  card,
  connection,
  applications,
  onClose,
  onSaved,
}: {
  card: ConnectionCard;
  connection: ConnectionView;
  applications: ApplicationSetupView[];
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const setup = applications.find((item) => item.provider === connection.host);
  const texts = hostTexts(connection.host)?.application;
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={`Replace ${card.label} application`}
      sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <Typography variant="h6" component="h2">
        Replace the {card.label} application
      </Typography>
      {setup && texts && connection.app ? (
        <ApplicationForm
          setup={setup}
          label={card.label}
          texts={texts}
          replacing={{ name: connection.app.name, connected: connection.connected ?? [] }}
          onSaved={onSaved}
        />
      ) : (
        <Typography variant="body2" color="text.secondary">
          This server does not take a new application for {card.label} here.
        </Typography>
      )}
      <Box>
        <Button size="small" onClick={onClose}>
          Cancel
        </Button>
      </Box>
    </Paper>
  );
}

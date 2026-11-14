'use client';

import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import type { ConnectionCard } from '@contract/connections';
import { logoFor } from './logos';

/** The head every card shares, drawn from its description: logo, name, what it is for and the server default. `children` are further chips. */
export function CardHeading({ card, children }: { card: ConnectionCard; children?: ReactNode }): ReactElement {
  const Logo = logoFor(card.logo);
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Logo sx={{ color: 'text.secondary' }} />
        <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
          {card.label}
        </Typography>
        {children}
        {card.serverDefault ? <Chip size="small" label="Server default" /> : null}
      </Box>
      <Typography variant="body2" color="text.secondary">
        {card.purpose}
      </Typography>
    </>
  );
}

'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { DeliveryView } from '@contract/delivery';

const WORDS: Record<DeliveryView['state'], string> = {
  read: 'only read, nothing to publish',
  publishing: 'publishing',
  published: 'published',
};

/** Each repository of a run with what the run delivers of it. */
export function RunDelivery({ delivery }: { delivery: DeliveryView[] }): ReactElement | null {
  if (delivery.length === 0) {
    return null;
  }
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 0.5 }}>
      {delivery.map((entry) => (
        <Typography key={entry.repo} variant="body2" color="text.secondary">
          {`${entry.repo} · ${WORDS[entry.state]}`}
        </Typography>
      ))}
    </Box>
  );
}

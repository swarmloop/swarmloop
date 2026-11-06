import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Side } from './transcript-model';

/** The box every card sits in: inputs hug the right edge, actions the left. It never grows wider than the feed. */
export function CardFrame({ side, label, children }: { side: Side; label: string; children: ReactNode }): ReactElement {
  return (
    <Box
      sx={{
        alignSelf: side === 'right' ? 'flex-end' : 'flex-start',
        minWidth: 0,
        maxWidth: '85%',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        overflowWrap: 'anywhere',
      }}
    >
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ fontSize: 13, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

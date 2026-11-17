'use client';

import { type ReactElement, type ReactNode, useState } from 'react';
import ButtonBase from '@mui/material/ButtonBase';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/** One muted sentence. With `detail` it is a button that opens the whole text in place. */
export function InfoLine({
  sentence,
  detail,
  label = 'Show details',
}: {
  sentence: string;
  detail?: ReactNode;
  /** What the screen reader says of the button that opens the detail. */
  label?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const line = (
    <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', textAlign: 'left' }}>
      {sentence}
    </Typography>
  );
  if (!detail) {
    return <Box sx={{ px: 1 }}>{line}</Box>;
  }
  return (
    <Box sx={{ px: 1 }}>
      <ButtonBase
        aria-expanded={open}
        aria-label={`${label}: ${sentence}`}
        onClick={() => setOpen((value) => !value)}
        sx={{ display: 'block', width: '100%', borderRadius: 1, textAlign: 'left' }}
      >
        {line}
      </ButtonBase>
      {open ? (
        <Box sx={{ mt: 0.5, pl: 1, borderLeft: 2, borderColor: 'divider', overflowWrap: 'anywhere' }}>{detail}</Box>
      ) : null}
    </Box>
  );
}

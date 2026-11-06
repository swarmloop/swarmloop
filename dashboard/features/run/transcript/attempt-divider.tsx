import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { AttemptGroup } from './transcript-model';

/** A rule with the attempt on it. The text wraps, so a long reason never widens the feed. */
export function AttemptDivider({ group }: { group: AttemptGroup }): ReactElement {
  const detail = [group.reason, group.runtime, group.model].filter(Boolean).join(' · ');
  return (
    <Box role="separator" sx={{ my: 1, minWidth: 0, borderTop: 1, borderColor: 'divider', textAlign: 'center' }}>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        Attempt {group.number}
        {detail ? ` · ${detail}` : ''}
      </Typography>
    </Box>
  );
}

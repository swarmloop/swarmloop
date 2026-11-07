import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { AttemptGroup } from './transcript-model';

/** A rule with the attempt on it: why it ran, with which model, and how it ended. The text wraps, so a long line never widens the feed. */
export function AttemptDivider({ group }: { group: AttemptGroup }): ReactElement {
  const head = ['Attempt ' + group.number, group.why, group.modelName].filter(Boolean).join(' · ');
  return (
    <Box role="separator" sx={{ my: 1, minWidth: 0, borderTop: 1, borderColor: 'divider', textAlign: 'center' }}>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', display: 'block' }}>
        {head}
      </Typography>
      {group.outcome ? (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', display: 'block' }}>
          {group.outcome}
        </Typography>
      ) : null}
    </Box>
  );
}

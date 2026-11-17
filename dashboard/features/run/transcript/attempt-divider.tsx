import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SIZE, SPACE } from './tokens';
import type { AttemptGroup } from './transcript-model';

/**
 * A thin rule with the attempt on it as a plain caption: why it ran, with which model, and how it ended. It sticks under
 * the top bar while its attempt is in view. The text wraps, so a long line never widens the feed.
 */
export function AttemptDivider({ group }: { group: AttemptGroup }): ReactElement {
  const head = ['Attempt ' + group.number, group.why, group.modelName].filter(Boolean).join(' · ');
  return (
    <Box
      role="separator"
      sx={{
        position: 'sticky',
        top: SIZE.topBar,
        zIndex: 1,
        mt: SPACE.divider,
        py: SPACE.part,
        minWidth: 0,
        display: 'flex',
        justifyContent: 'center',
        bgcolor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Box
        sx={{
          position: 'relative',
          maxWidth: '100%',
          textAlign: 'center',
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', display: 'block' }}>
          {head}
        </Typography>
        {group.outcome ? (
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', display: 'block' }}>
            {group.outcome}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { RADIUS, SIZE, SPACE } from './tokens';
import type { AttemptGroup } from './transcript-model';

/**
 * A pill on a hairline with the attempt on it: why it ran, with which model, and how it ended. It sticks under the top
 * bar while its attempt is in view. The text wraps, so a long line never widens the feed.
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
        bgcolor: 'background.default',
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 0,
          right: 0,
          top: '50%',
          borderTop: 1,
          borderColor: 'divider',
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          maxWidth: '100%',
          px: SPACE.pad,
          py: SPACE.group,
          border: 1,
          borderColor: 'divider',
          borderRadius: RADIUS.pill,
          bgcolor: 'background.paper',
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

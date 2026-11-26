'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { stepState } from '@contract/step-state';
import { localTime } from '../../../lib/format';
import { StepStateIcon } from '../../run';

/** The planner's row while a turn works: the working icon of the state icon map, a plain line, and when the turn started. */
export function ThinkingRow({ startedAt }: { startedAt: string | null }): ReactElement {
  return (
    <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
      <StepStateIcon state={stepState('running', null)} />
      <Typography variant="body2" color="text.secondary">
        The planner is thinking…
      </Typography>
      {startedAt ? (
        <Typography variant="caption" color="text.secondary">
          {`Started at ${localTime(startedAt)}`}
        </Typography>
      ) : null}
    </Box>
  );
}

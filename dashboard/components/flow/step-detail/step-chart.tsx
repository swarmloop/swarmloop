'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import { SeriesChart } from '../../charts/series';
import { StepView } from '@contract/api';

export function StepChart({ visit }: { visit: StepView['visits'][number] | undefined }): ReactElement | null {
  if (!visit || (visit.status !== 'running' && visit.samples.length === 0)) {
    return null;
  }
  return (
    <Box sx={{ mt: 2 }}>
      <SeriesChart samples={visit.samples} />
    </Box>
  );
}

'use client';

import Box from '@mui/material/Box';
import { SeriesChart } from '../../charts/series';
import { StepView } from '../../../lib/types';

export function StepChart({ visit }: { visit: StepView['visits'][number] | undefined }) {
  if (!visit || (visit.status !== 'running' && visit.samples.length === 0)) {
    return null;
  }
  return (
    <Box sx={{ mt: 2 }}>
      <SeriesChart samples={visit.samples} />
    </Box>
  );
}

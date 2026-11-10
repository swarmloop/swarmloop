'use client';

import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ReadinessPanel } from '../features/readiness';
import { useLiveBridge } from '../features/shell';
import { StatsSection } from '../features/stats';

export default function HomePage(): React.ReactElement {
  const runs = useLiveBridge((snapshot) => snapshot.runs);
  // The statistics reload when a run appears, goes or changes status, not on every live tick.
  const version = useMemo(() => runs.map((run) => `${run.key}:${run.status}`).join(','), [runs]);
  const active = runs.filter((run) => run.status === 'running').length;
  const waiting = runs.filter((run) => run.status === 'waiting').length;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 1480 }}>
      <Box>
        <Typography variant="h5" component="h1">
          Overview
        </Typography>
        <Typography color="text.secondary">
          {runs.length === 0
            ? 'No runs yet. New run, top right, starts one.'
            : `${active} running · ${waiting} waiting · ${runs.length} in the list`}
        </Typography>
      </Box>
      <ReadinessPanel />
      <StatsSection version={version} />
    </Box>
  );
}

'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { StatsSection, useStatsVersion } from '../../features/stats';

export default function StatsPage(): React.ReactElement {
  const version = useStatsVersion();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 1480 }}>
      <Typography variant="h5" component="h1">
        Stats
      </Typography>
      <StatsSection version={version} />
    </Box>
  );
}

'use client';

import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Link from 'next/link';
import { ReadinessPanel } from '../features/readiness';
import { useLiveBridge } from '../features/shell';
import { StatsSection } from '../features/stats';
import { HOSTS } from './login/hosts';

export default function HomePage(): React.ReactElement {
  const runs = useLiveBridge((snapshot) => snapshot.runs);
  const loaded = useLiveBridge((snapshot) => snapshot.loaded);
  // The same counts as the run list's switch, so a subtask is never counted on its own.
  const { active, done, all } = useLiveBridge((snapshot) => snapshot.counts);
  // The statistics reload when a run appears, goes, changes status or changes part, not on every live tick.
  const version = useMemo(
    () => `${runs.map((run) => `${run.key}:${run.status}`).join(',')}|${active}/${done}/${all}`,
    [runs, active, done, all],
  );
  const empty = loaded && all === 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 1480 }}>
      <Box>
        <Typography variant="h5" component="h1">
          Overview
        </Typography>
        {loaded ? (
          <Typography color="text.secondary">
            {empty ? 'No runs yet. New run, top right, starts one.' : `${active} active · ${done} done · ${all} runs`}
          </Typography>
        ) : (
          <Skeleton width={240} aria-label="Loading runs" />
        )}
        {empty ? (
          <Button component={Link} href="/connections" variant="outlined" size="small" sx={{ mt: 1.5 }}>
            {`Connect ${Object.values(HOSTS)
              .map((host) => host.label)
              .join(' or ')}`}
          </Button>
        ) : null}
      </Box>
      <ReadinessPanel />
      <StatsSection version={version} />
    </Box>
  );
}

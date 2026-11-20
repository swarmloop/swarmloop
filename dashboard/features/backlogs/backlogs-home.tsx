'use client';

import { type ReactElement, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { backlogPath } from '../../lib/backlog-path';
import { NewBacklogDialog } from './new-backlog-dialog';
import { useBacklogs } from './use-backlogs';

/** Opens the first backlog, or offers to make one when there is none. */
export function BacklogsHome(): ReactElement | null {
  const router = useRouter();
  const { backlogs, loaded } = useBacklogs();
  const [creating, setCreating] = useState(false);
  const first = backlogs[0]?.name;
  useEffect(() => {
    if (first !== undefined) {
      router.replace(backlogPath(first));
    }
  }, [first, router]);
  if (!loaded || first !== undefined) {
    return null;
  }
  return (
    <Box sx={{ display: 'grid', gap: 2, justifyItems: 'start' }}>
      <Typography variant="h5" component="h1">
        No backlogs yet
      </Typography>
      <Typography color="text.secondary">A backlog plans the work of your repositories with you.</Typography>
      <Button variant="contained" onClick={() => setCreating(true)}>
        + New backlog
      </Button>
      <NewBacklogDialog open={creating} onClose={() => setCreating(false)} />
    </Box>
  );
}

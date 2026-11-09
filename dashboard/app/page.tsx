'use client';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ReadinessPanel, useReadiness } from '../features/readiness';
import { useNewRun } from '../features/shell';

export default function HomePage(): React.ReactElement {
  const open = useNewRun();
  const { blocker } = useReadiness();
  return (
    <Stack spacing={2} alignItems="flex-start">
      <Typography color="text.secondary">Select a run, or start one.</Typography>
      <ReadinessPanel />
      <Stack direction="row" spacing={2} alignItems="center">
        <Button variant="contained" onClick={open} disabled={blocker !== null}>
          New run
        </Button>
        {blocker ? (
          <Typography variant="body2" color="error">
            {blocker.action}
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}

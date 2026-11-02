'use client';

import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useNewRun } from '../components/shell';

export default function HomePage() {
  const open = useNewRun();
  return (
    <>
      <Typography color="text.secondary">Select a run, or start one.</Typography>
      <Button variant="contained" sx={{ mt: 2 }} onClick={open}>
        New run
      </Button>
    </>
  );
}

'use client';

import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { RunSummary } from '../../lib/types';

export function RemoveRunDialog({
  run,
  removing,
  error,
  onClose,
  onConfirm,
}: {
  run: RunSummary | null;
  removing: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={run !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Remove {run?.name}?</DialogTitle>
      <DialogContent>
        <Typography>This deletes the run's saved rows and files.</Typography>
        {error ? (
          <Typography color="error" variant="body2" sx={{ mt: 1 }}>
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={removing}>
          Cancel
        </Button>
        <Button color="error" variant="contained" disabled={removing || !run} onClick={onConfirm}>
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  );
}

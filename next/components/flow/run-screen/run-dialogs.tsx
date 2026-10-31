'use client';

import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { PhaseName } from '../../../lib/phases';
import { FlowView } from '../../../lib/types';

export function RunDialogs({
  flow,
  error,
  stopping,
  confirmStop,
  setConfirmStop,
  pending,
  setPending,
  replay,
  stopRun,
  startReplay,
  setError,
}: {
  flow: FlowView;
  error: string | null;
  stopping: boolean;
  confirmStop: boolean;
  setConfirmStop: (open: boolean) => void;
  pending: { prompt: string; phases: PhaseName[] } | null;
  setPending: (pending: { prompt: string; phases: PhaseName[] } | null) => void;
  replay: string | null;
  stopRun: () => void;
  startReplay: (step: string, prompt: string, phases: PhaseName[]) => Promise<void>;
  setError: (error: string | null) => void;
}) {
  return (
    <>
      <Dialog open={confirmStop} onClose={() => (stopping ? undefined : setConfirmStop(false))} fullWidth maxWidth="xs">
        <DialogTitle>Stop {flow.currentStep}?</DialogTitle>
        <DialogContent>
          <Typography>The agent for {flow.key} is killed and this run is marked failed. Files already written stay in the worktree.</Typography>
          {error ? (
            <Typography color="error" variant="body2" sx={{ mt: 1 }}>
              {error}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmStop(false)} disabled={stopping}>
            Keep running
          </Button>
          <Button color="error" variant="contained" disabled={stopping} onClick={stopRun}>
            Stop
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={pending !== null} onClose={() => setPending(null)} fullWidth maxWidth="sm">
        <DialogTitle>Stop {flow.currentStep}?</DialogTitle>
        <DialogContent>
          <Typography>
            {flow.currentStep} is running. Starting {replay} again stops it.
          </Typography>
          {error ? (
            <Typography color="error" variant="body2" sx={{ mt: 1 }}>
              {error}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPending(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (replay && pending) {
                startReplay(replay, pending.prompt, pending.phases).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'replay failed'));
              }
            }}
          >
            Stop and start
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

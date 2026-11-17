'use client';

import { useState, type ReactElement, type ReactNode } from 'react';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';

/** The one confirm for every dangerous action: the same size, layout, focus, keys, progress and error handling. */
export function ConfirmDialog({
  open,
  title,
  body,
  verb,
  tone,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  /** The action button's label, the action itself. */
  verb: string;
  tone: 'danger' | 'primary';
  /** Sends the action. A rejection shows in the dialog; a resolve closes it. */
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}): ReactElement {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('sm'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    if (!busy) {
      setError(null);
      onClose();
    }
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof Error && cause.message ? cause.message : `${verb} did not work. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      fullScreen={phone}
      slotProps={{ paper: { sx: { width: phone ? undefined : 440, maxWidth: '100%' } } }}
      aria-labelledby="confirm-title"
    >
      <DialogTitle id="confirm-title">{title}</DialogTitle>
      <DialogContent>
        <Typography component="div">{body}</Typography>
        {error ? (
          <Typography role="alert" color="error" variant="body2" sx={{ mt: 1 }}>
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between' }}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- Cancel takes focus first, so Enter never confirms by accident */}
        <Button autoFocus onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          color={tone === 'danger' ? 'error' : 'primary'}
          variant="contained"
          disabled={busy}
          onClick={() => void confirm()}
          startIcon={busy ? <CircularProgress size={16} color="inherit" aria-label="Working" /> : undefined}
        >
          {verb}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

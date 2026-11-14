'use client';

import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import type { SignInView } from '@contract/connections';
import type { FlowDialogProps } from './flow-types';

/** The frame the two sign-in dialogs share: progress while waiting, the link, the provider's message, and the end. */
export function SignInDialog({
  card,
  flow,
  view,
  error,
  onClose,
  onSaved,
  children,
}: FlowDialogProps & { view: SignInView | null; error: string | null; children?: ReactNode }): ReactElement {
  const done = view?.state === 'done';
  useEffect(() => {
    if (done) {
      onSaved();
      onClose();
    }
  }, [done, onSaved, onClose]);
  const failure = error ?? (view?.state === 'failed' ? (view.message ?? 'the sign-in failed') : null);
  return (
    <Dialog open onClose={onClose} aria-labelledby={`${card.id}-flow-title`} fullWidth maxWidth="xs">
      <DialogTitle id={`${card.id}-flow-title`}>{flow.label}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {view?.link ? (
          <Link href={view.link} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </Link>
        ) : null}
        {children}
        {view?.state === 'waiting' || view === null ? <LinearProgress aria-label="Waiting for the sign-in" /> : null}
        {failure ? <Alert severity="error">{failure}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

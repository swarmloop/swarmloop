'use client';

import { type ReactElement, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import type { RemoteEntry } from '@contract/api';
import type { BacklogView } from '@contract/backlog';
import { addBacklogRepository } from '../../lib/backlog-endpoints';
import { listProjects } from '../../lib/endpoints';
import { mergeNames } from '../../lib/names';
import { ProjectPicker, useRemoteList } from '../new-run';

interface AddRepositoryDialogProps {
  open: boolean;
  view: BacklogView;
  onClose: () => void;
  onView: (view: BacklogView) => void;
}

export function AddRepositoryDialog({ open, view, onClose, onView }: AddRepositoryDialogProps): ReactElement {
  const [available, setAvailable] = useState<string[]>([]);
  const { remote, error: remoteError, reload, retry } = useRemoteList(open);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    listProjects()
      .then((body) => setAvailable(body.projects))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'projects failed'));
  }, [open]);

  const created = (entry: RemoteEntry): void => setAvailable((current) => mergeNames(current, [entry.name]));

  const add = (picked: string[]): void => {
    const repository = picked[picked.length - 1];
    if (busy || repository === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    addBacklogRepository(view.name, { repository })
      .then((answer) => {
        onView(answer);
        onClose();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'repository failed'))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add a repository</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, '&&': { pt: 2.5 } }}>
        <ProjectPicker
          frozenProjects={false}
          projectOptions={available.filter((name) => !view.repositories.includes(name))}
          pickedProjects={[]}
          onChange={add}
          remote={remote}
          remoteError={remoteError}
          onRetry={retry}
          onRemoteLost={reload}
          onCreated={created}
        />
        {error ? <Alert severity="error">{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

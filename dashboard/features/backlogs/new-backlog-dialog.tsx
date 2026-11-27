'use client';

import { type ReactElement, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import type { RemoteEntry } from '@contract/api';
import type { MergeMode } from '@contract/backlog';
import { backlogPath } from '../../lib/backlog-path';
import { createBacklog } from '../../lib/backlog-endpoints';
import { listProjects } from '../../lib/endpoints';
import { mergeNames } from '../../lib/names';
import { ProjectPicker, useRemoteList } from '../new-run';

export function NewBacklogDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const router = useRouter();
  const [name, setName] = useState('');
  const [available, setAvailable] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const { remote, error: remoteError, reload, retry } = useRemoteList(open);
  const [mergeMode, setMergeMode] = useState<MergeMode>('green');
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

  const created = (entry: RemoteEntry): void => {
    setAvailable((current) => mergeNames(current, [entry.name]));
    setPicked((current) => mergeNames(current, [entry.name]));
  };

  const create = (): void => {
    setBusy(true);
    setError(null);
    createBacklog({ name: name.trim(), repositories: picked, mergeMode })
      .then((view) => {
        onClose();
        router.push(backlogPath(view.name));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'backlog failed'))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New backlog</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, '&&': { pt: 2.5 } }}>
        <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <ProjectPicker
          frozenProjects={false}
          projectOptions={available}
          pickedProjects={picked}
          onChange={setPicked}
          remote={remote}
          remoteError={remoteError}
          onRetry={retry}
          onRemoteLost={reload}
          onCreated={created}
        />
        <FormControl>
          <FormLabel id="backlog-merge-mode">Merge mode</FormLabel>
          <RadioGroup
            row
            aria-labelledby="backlog-merge-mode"
            value={mergeMode}
            onChange={(event) => setMergeMode(event.target.value as MergeMode)}
          >
            <FormControlLabel value="green" control={<Radio />} label="merge on green" />
            <FormControlLabel value="ok" control={<Radio />} label="wait for my OK" />
          </RadioGroup>
        </FormControl>
        {error ? <Alert severity="error">{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={create} disabled={busy || name.trim() === ''}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

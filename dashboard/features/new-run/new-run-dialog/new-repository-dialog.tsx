'use client';

import { type ReactElement, useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { RemoteEntry, RepositoryOwner } from '@contract/api';
import { createRepository } from '../../../lib/endpoints';
import { useCommandOutcome } from '../../shell';

const MAX_NAME = 100;

/** The first rule a name breaks, or null. The server stays the authority. */
function nameProblem(name: string, allowedNames: readonly string[], existingNames: readonly string[]): string | null {
  if (name === '') {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return 'Use letters, digits, dots, dashes and underscores only';
  }
  if (name.startsWith('.') || name.startsWith('-')) {
    return 'The name cannot start with a dot or a dash';
  }
  if (name.endsWith('.git')) {
    return 'The name cannot end with .git';
  }
  if (name.length > MAX_NAME) {
    return `At most ${MAX_NAME} characters`;
  }
  if (allowedNames.length > 0 && !allowedNames.includes(name)) {
    return `${name} is not in SWARMLOOP_REPOS`;
  }
  if (existingNames.includes(name)) {
    return `${name} already exists`;
  }
  return null;
}

/** The key a create is sent with: it stays while the inputs stay and no failure is known, so a resend is the same command. */
interface CreateAttempt {
  key: string;
  inputs: { host: string; owner: string; name: string; public: boolean };
}

const ownerKey = (owner: RepositoryOwner): string => `${owner.host}:${owner.login}`;

export function NewRepositoryDialog({
  open,
  owners,
  allowedNames,
  existingNames,
  onClose,
  onLost,
  onCreated,
}: {
  open: boolean;
  owners: readonly RepositoryOwner[];
  allowedNames: readonly string[];
  /** Local projects and every remote repository: a name among them cannot be created. */
  existingNames: readonly string[];
  onClose: () => void;
  /** The answer of a create was lost, so the list may already hold the repository. */
  onLost: () => void;
  onCreated: (entry: RemoteEntry) => void;
}): ReactElement {
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandId, setCommandId] = useState<string | null>(null);
  const attempt = useRef<CreateAttempt | null>(null);
  const owner = owners.find((item) => ownerKey(item) === chosen) ?? owners[0];
  const problem = nameProblem(name, allowedNames, existingNames);
  const ready = owner !== undefined && name !== '' && problem === null && !busy;
  const outcome = useCommandOutcome(commandId);

  useEffect(() => {
    if (outcome === null) {
      return;
    }
    setCommandId(null);
    setBusy(false);
    if (outcome.state === 'succeeded') {
      attempt.current = null;
      setName('');
      setIsPublic(false);
      onCreated(outcome.value as RemoteEntry);
      onClose();
      return;
    }
    attempt.current = null;
    setError(outcome.error?.message ?? 'create failed');
  }, [outcome, onCreated, onClose]);

  const create = (): void => {
    if (!owner || !ready) {
      return;
    }
    const inputs = { host: owner.host, owner: owner.login, name, public: isPublic };
    const same = attempt.current !== null && JSON.stringify(attempt.current.inputs) === JSON.stringify(inputs);
    const key = same && attempt.current ? attempt.current.key : crypto.randomUUID();
    attempt.current = { key, inputs };
    setBusy(true);
    setError(null);
    createRepository(inputs, key)
      .then((accepted) => setCommandId(accepted.commandId))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'create failed');
        setBusy(false);
        onLost();
      });
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>New repository</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, '&&': { pt: 2.5 } }}>
        <TextField
          select
          label="Owner"
          value={owner ? ownerKey(owner) : ''}
          onChange={(event) => setChosen(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        >
          {owners.map((item) => (
            <MenuItem key={ownerKey(item)} value={ownerKey(item)}>
              {item.login}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the name is the first thing to type, so it takes focus when the dialog opens
          autoFocus
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={problem !== null}
          helperText={problem ?? ' '}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <FormControlLabel
          control={<Checkbox checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />}
          label="Public"
        />
        {error ? (
          <Typography color="error" variant="body2" role="alert">
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!ready}
          onClick={create}
          startIcon={busy ? <CircularProgress size={16} color="inherit" aria-label="Creating" /> : undefined}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

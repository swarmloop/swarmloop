'use client';

import { type ReactElement, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import { pauseBacklog, unpauseBacklog } from '../../lib/backlog-endpoints';
import { AddRepositoryDialog } from './add-repository-dialog';
import { RepositoryChip } from './repository-chip';

interface BacklogHeaderProps {
  view: BacklogView;
  login: string | null;
  onView: (view: BacklogView) => void;
}

export function BacklogHeader({ view, login, onView }: BacklogHeaderProps): ReactElement {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (): void => {
    setBusy(true);
    setError(null);
    (view.paused ? unpauseBacklog : pauseBacklog)(view.name)
      .then(onView)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'pause failed'))
      .finally(() => setBusy(false));
  };

  return (
    <Box
      component="section"
      aria-label="Backlog header"
      sx={{ minHeight: 56, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}
    >
      <Typography variant="h5" component="h1">
        {view.name}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
        {view.repositories.map((repository) => (
          <RepositoryChip key={repository} repository={repository} />
        ))}
        {login !== null && login === view.owner ? (
          <Chip
            size="small"
            variant="outlined"
            clickable
            icon={<AddIcon />}
            aria-label="Add a repository"
            onClick={() => setAdding(true)}
          />
        ) : null}
      </Box>
      {login !== null ? (
        <FormControlLabel
          sx={{ ml: 'auto' }}
          label="Paused"
          control={<Switch checked={view.paused} disabled={busy} onChange={toggle} />}
        />
      ) : null}
      {error ? (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {login !== null && login === view.owner ? (
        <AddRepositoryDialog open={adding} view={view} onClose={() => setAdding(false)} onView={onView} />
      ) : null}
    </Box>
  );
}

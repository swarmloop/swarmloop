'use client';

import { type ReactElement, useState } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { backlogPath } from '../../lib/backlog-path';
import { NewBacklogDialog } from './new-backlog-dialog';
import { progressLine } from './progress-line';
import { useBacklogs } from './use-backlogs';

/** The backlogs, one item each; the list is also the switch between them. */
export function BacklogList({ selected, onPick }: { selected: string; onPick?: () => void }): ReactElement {
  const { backlogs, error } = useBacklogs();
  const [creating, setCreating] = useState(false);
  return (
    <Box component="nav" aria-label="Backlogs" sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <List sx={{ overflowY: 'auto', flex: 1 }}>
        {backlogs.map((backlog) => (
          <ListItemButton
            key={backlog.name}
            component={Link}
            href={backlogPath(backlog.name)}
            selected={backlog.name === selected}
            aria-current={backlog.name === selected ? 'page' : undefined}
            onClick={onPick}
          >
            <ListItemText primary={backlog.name} secondary={progressLine(backlog) || undefined} />
          </ListItemButton>
        ))}
      </List>
      {error ? (
        <Box role="alert" sx={{ px: 2, color: 'error.main' }}>
          {error}
        </Box>
      ) : null}
      <Box sx={{ p: 1 }}>
        <Button onClick={() => setCreating(true)}>+ New backlog</Button>
      </Box>
      <NewBacklogDialog open={creating} onClose={() => setCreating(false)} />
    </Box>
  );
}

'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import { money } from '../../lib/format';
import { RunStateIcon, toneColor } from '../run';
import { RowDelete, useRowReveal } from './row-delete';
import { rowButtonSx } from './row-style';
import { runWord } from './run-word';

/** One task of an epic as a smaller, muted line. A task that needs a person or has failed keeps its tone color. */
export function TaskLine({
  run,
  selected,
  onOpen,
  onRemove,
}: {
  run: RunSummary;
  selected: boolean;
  onOpen: (key: string) => void;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  const { shown, handlers } = useRowReveal();
  const view = runWord(run);
  const loud = view.tone === 'person' || view.tone === 'error';
  return (
    <ListItem disablePadding disableGutters {...handlers}>
      <ListItemButton
        component="div"
        data-nav
        selected={selected}
        onClick={() => onOpen(run.key)}
        sx={{ ...rowButtonSx(selected), py: 0.25, px: 1, gap: 0.75, alignItems: 'center' }}
      >
        <Box sx={{ display: 'flex' }}>
          <RunStateIcon view={view} size={14} />
        </Box>
        <Typography
          variant="caption"
          noWrap
          sx={{ flex: 1, minWidth: 0, color: loud ? toneColor(view.tone) : 'text.secondary' }}
        >
          {run.name}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {money(run.usd)}
        </Typography>
        <RowDelete run={run} shown={shown} onRemove={onRemove} />
      </ListItemButton>
    </ListItem>
  );
}

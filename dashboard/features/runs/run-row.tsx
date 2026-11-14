'use client';

import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import { duration, money, relative, when } from '../../lib/format';
import { RunStateIcon } from '../run';
import { RowDelete, useRowReveal } from './row-delete';
import { rowButtonSx } from './row-style';
import { runWord } from './run-word';

const ELLIPSIS = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  overflowWrap: 'anywhere',
} as const;

/** One run as two lines: its state, name and last change, then its state word, step, time and cost. */
export function RunRow({
  run,
  selected,
  now,
  toggle = null,
  extras = null,
  onOpen,
  onRemove,
}: {
  run: RunSummary;
  selected: boolean;
  now: number;
  /** The epic toggle at the start of line 1. */
  toggle?: ReactNode;
  /** The epic task summary at the end of line 2. */
  extras?: ReactNode;
  onOpen: (key: string) => void;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  const { shown, handlers } = useRowReveal();
  const view = runWord(run);
  const step = view.tone === 'working' && run.state !== 'done' ? run.currentStep.replace(/[-_]/g, ' ') : '';
  const totals = run.epic ?? run;
  const parts = [step, duration(totals.durationMs), money(totals.usd)].filter(Boolean);
  return (
    <ListItem disablePadding disableGutters sx={{ mb: 0.5 }} {...handlers}>
      <ListItemButton
        component="div"
        data-nav
        selected={selected}
        onClick={() => onOpen(run.key)}
        sx={{ ...rowButtonSx(selected), alignItems: 'flex-start', py: 0.75, px: 1 }}
      >
        <Box sx={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, minWidth: 0 }}>
            {toggle}
            <Box sx={{ pt: 0.25, display: 'flex' }}>
              <RunStateIcon view={view} size={16} />
            </Box>
            <Typography variant="body2" sx={{ fontWeight: 500, flex: 1, minWidth: 0, ...ELLIPSIS }}>
              {run.name}
            </Typography>
            <Tooltip title={`Started ${when(run.createdAt)} · Last change ${when(run.updatedAt)}`}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
              >
                {relative(run.updatedAt, new Date(now))}
              </Typography>
            </Tooltip>
            <RowDelete run={run} shown={shown} onRemove={onRemove} />
          </Box>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ pl: toggle ? 3.5 : 0, ml: 2.75, fontVariantNumeric: 'tabular-nums', minWidth: 0 }}
          >
            <Tooltip title={view.tip}>
              <span>{view.word}</span>
            </Tooltip>
            {parts.map((part) => ` · ${part}`).join('')}
            {extras}
          </Typography>
        </Box>
      </ListItemButton>
    </ListItem>
  );
}

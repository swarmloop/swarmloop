'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { StatsUnit } from '@contract/api';
import { hours, usd } from './stats-format';

function Figures({ label, unit }: { label: string; unit: StatsUnit }): ReactElement {
  const time = unit.medianMs === null ? '—' : hours(unit.medianMs);
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }} aria-label={label} role="group">
      <Typography variant="body2" color="text.secondary" noWrap>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.2, mt: 0.25 }}>
        {unit.finished} finished
      </Typography>
      <Box sx={{ mt: 0.5, fontSize: 13, color: 'text.secondary' }}>
        <Box component="span">median cost {usd(unit.medianUsd)}</Box> · <Box component="span">median time {time}</Box> ·{' '}
        <Box component="span">{unit.active} in progress</Box>
      </Box>
    </Paper>
  );
}

/** Epics and tasks side by side: what each has finished, what the median one costs and takes, and how many are going. */
export function UnitFigures({ epics, tasks }: { epics: StatsUnit; tasks: StatsUnit }): ReactElement {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
      <Figures label="Epics" unit={epics} />
      <Figures label="Tasks" unit={tasks} />
    </Box>
  );
}

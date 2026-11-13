'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import HourglassEmpty from '@mui/icons-material/HourglassEmpty';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { MachineLoad, ReadinessItem } from '@contract/readiness';
import { NAMES, STATUS } from './readiness-panel';
import { useReadiness } from './use-readiness';

/** Gigabytes with one decimal, and no `.0`: `9.1`, `12`. */
function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Details({ items, load }: { items: ReadinessItem[]; load: MachineLoad | null }): ReactElement {
  const listed = items.filter((item) => item.status !== 'ok');
  return (
    <Box>
      {listed.map((item) => (
        <Typography key={item.id} variant="body2">
          {NAMES[item.id]}: {item.line}
        </Typography>
      ))}
      {load && load.waiting.length > 0 ? (
        <>
          <Typography variant="body2">
            Memory booked: {gb(load.usedMemoryBytes)} of {gb(load.capacityMemoryBytes)} GB
          </Typography>
          <Typography variant="body2">Waiting work starts when its memory fits.</Typography>
        </>
      ) : null}
    </Box>
  );
}

/** The compact header item: setup problems first, then work waiting for the machine, then setup warnings; else nothing. */
export function ReadinessStatus(): ReactElement | null {
  const { items, load } = useReadiness();
  const failing = items.filter((item) => item.status === 'fail').length;
  const warning = items.filter((item) => item.status === 'warn').length;
  const waiting = load?.waiting.length ?? 0;
  let shown: { Icon: typeof HourglassEmpty; color: string; text: string };
  if (failing > 0) {
    shown = {
      Icon: STATUS.fail.Icon,
      color: STATUS.fail.color,
      text: plural(failing, 'setup problem', 'setup problems'),
    };
  } else if (waiting > 0) {
    shown = { Icon: HourglassEmpty, color: 'warning.main', text: `${waiting} waiting for machine` };
  } else if (warning > 0) {
    shown = {
      Icon: STATUS.warn.Icon,
      color: STATUS.warn.color,
      text: plural(warning, 'setup warning', 'setup warnings'),
    };
  } else {
    return null;
  }
  return (
    <Tooltip title={<Details items={items} load={load} />} arrow disableInteractive>
      <Box
        component={Link}
        href="/#readiness"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          mr: 2,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        <shown.Icon fontSize="small" sx={{ color: shown.color }} />
        <Typography variant="body2" color="text.secondary">
          {shown.text}
        </Typography>
      </Box>
    </Tooltip>
  );
}

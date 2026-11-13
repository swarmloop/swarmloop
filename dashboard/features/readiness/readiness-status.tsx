'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { MachineLoad, ReadinessItem } from '@contract/readiness';
import { NAMES, STATUS } from './readiness-panel';
import { useReadiness } from './use-readiness';

function worst(items: ReadinessItem[]): ReadinessItem['status'] | null {
  if (items.length === 0) {
    return null;
  }
  return items.some((item) => item.status === 'fail')
    ? 'fail'
    : items.some((item) => item.status === 'warn')
      ? 'warn'
      : 'ok';
}

function Meter({ label, used, capacity }: { label: string; used: number; capacity: number }): ReactElement {
  const percent = Math.min(100, Math.round((used / capacity) * 100));
  return (
    <Box
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      sx={{ width: 28, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden' }}
    >
      <Box sx={{ width: `${percent}%`, height: '100%', bgcolor: 'primary.main' }} />
    </Box>
  );
}

function Details({ items, load }: { items: ReadinessItem[]; load: MachineLoad | null }): ReactElement {
  const failing = items.filter((item) => item.status === 'fail');
  return (
    <Box>
      {failing.map((item) => (
        <Typography key={item.id} variant="body2">
          {NAMES[item.id]}: {item.line}
        </Typography>
      ))}
      {load ? (
        <>
          <Typography variant="body2">Running: {load.running.join(', ') || 'none'}</Typography>
          <Typography variant="body2">Waiting: {load.waiting.join(', ') || 'none'}</Typography>
        </>
      ) : (
        <Typography variant="body2">No limit is known</Typography>
      )}
    </Box>
  );
}

/** The compact header item: the worst readiness color and the load of heavy work against the budget. */
export function ReadinessStatus(): ReactElement {
  const { items, load } = useReadiness();
  const status = worst(items);
  const sized = load !== null && load.capacityCpus > 0 && load.capacityMemoryBytes > 0;
  return (
    <Tooltip title={<Details items={items} load={load} />} arrow disableInteractive>
      <Box
        component={Link}
        href="/#readiness"
        aria-label={`Readiness: ${status ? STATUS[status].word : 'checking'}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          mr: 2,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        <Box
          component="span"
          data-testid="readiness-dot"
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: status ? STATUS[status].color : 'text.disabled' }}
        />
        {sized ? (
          <>
            <Meter label="CPU" used={load.usedCpus} capacity={load.capacityCpus} />
            <Meter label="Memory" used={load.usedMemoryBytes} capacity={load.capacityMemoryBytes} />
          </>
        ) : null}
      </Box>
    </Tooltip>
  );
}

'use client';

import type { ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReadinessItem } from '@contract/api';
import { useReadiness } from './use-readiness';

const COLOR = { ok: 'success', warn: 'warning', fail: 'error' } as const satisfies Record<
  ReadinessItem['status'],
  'success' | 'warning' | 'error'
>;

export function ReadinessPanel(): ReactElement | null {
  const { items, error } = useReadiness();
  if (error) {
    return <Alert severity="warning">Readiness is not available: {error}</Alert>;
  }
  if (items.length === 0) {
    return null;
  }
  return (
    <Stack spacing={0.75} aria-label="Readiness">
      {items.map((item) => (
        <Stack key={item.id} direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={item.status} color={COLOR[item.status]} sx={{ minWidth: 52 }} />
          <Typography variant="body2">
            <strong>{item.id}</strong>: {item.line}
            {item.status === 'ok' ? '' : ` — ${item.action}`}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

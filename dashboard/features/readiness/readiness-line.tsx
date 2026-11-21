'use client';

import type { ReactElement } from 'react';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { ReadinessPanel } from './readiness-panel';
import { useReadiness } from './use-readiness';

/** One line when everything is ready; the whole panel when a check warns or fails or the report cannot be read. */
export function ReadinessLine(): ReactElement {
  const { items, error, loading, refreshFailed } = useReadiness();
  if (loading) {
    return <Skeleton width={160} aria-label="Loading readiness" />;
  }
  if (error === null && !refreshFailed && items.every((item) => item.status === 'ok')) {
    return <Typography color="text.secondary">Everything is ready</Typography>;
  }
  return <ReadinessPanel />;
}

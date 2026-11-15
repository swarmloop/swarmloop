'use client';

import type { ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import { SERVER_PAUSE_NOTE } from '@contract/server-pause';
import { useLiveBridge } from './use-live-bridge';

/** One notice at the top while the server holds new containers for a restart. */
export function PauseBanner(): ReactElement | null {
  const paused = useLiveBridge((snapshot) => snapshot.paused);
  return paused ? <Alert severity="info">{SERVER_PAUSE_NOTE}</Alert> : null;
}

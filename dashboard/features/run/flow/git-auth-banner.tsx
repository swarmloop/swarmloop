import type { ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import Link from 'next/link';
import type { FlowView } from '@contract/api';
import { ERROR_CODES } from '@contract/error-codes';

/** One line at the top of a run that waits for its person to reconnect: it goes on by itself afterwards. */
export function GitAuthBanner({ flow }: { flow: FlowView }): ReactElement | null {
  const reason = flow.stateReason;
  if (reason?.code !== ERROR_CODES.GIT_AUTH) {
    return null;
  }
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      {reason.message}: the run goes on by itself once you reconnect on <Link href="/connections">Connections</Link>.
    </Alert>
  );
}

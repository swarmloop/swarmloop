import type { ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import type { FlowView } from '@contract/api';
import { ERROR_CODES } from '@contract/error-codes';
import { limitSentence } from '../../../lib/runtime-limit';

/** One line at the top of a run that waits for a provider's usage limit: which runtime, when it resets, when the run goes on. */
export function LimitBanner({ flow }: { flow: FlowView }): ReactElement | null {
  const reason = flow.stateReason;
  if (reason?.code !== ERROR_CODES.RUNTIME_LIMIT || !reason.limit) {
    return null;
  }
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      {limitSentence(reason.limit)}
    </Alert>
  );
}

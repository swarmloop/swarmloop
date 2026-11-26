import type { ReactElement } from 'react';
import Typography from '@mui/material/Typography';
import { interruptionSentence } from '@contract/interruption';
import { restartWaitSentence } from '@contract/restart-wait';
import type { VisitView } from '@contract/api';
import { localTime } from '../../../../lib/format';

/** What the step window says in one line under its header: why it sent work back, that the server restarted, or that an attempt was cut. */
export function StepNotice({
  returnWords,
  restartedAt,
  interruption,
}: {
  /** Why this step sent work back, in words from the server. */
  returnWords?: string;
  /** Set while the server's restart holds the step's agent. */
  restartedAt?: string;
  interruption?: VisitView['interruption'];
}): ReactElement {
  const cause = restartedAt
    ? restartWaitSentence(restartedAt, localTime)
    : interruption
      ? interruptionSentence(interruption, localTime)
      : null;
  return (
    <>
      {[returnWords, cause].map((text) =>
        text ? (
          <Typography key={text} variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {text}
          </Typography>
        ) : null,
      )}
    </>
  );
}

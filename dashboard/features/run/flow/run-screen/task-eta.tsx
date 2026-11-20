import type { ReactElement } from 'react';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { TaskEntry } from '@contract/api';
import { etaText } from '../../../../lib/eta-words';

/** The time left of a running or waiting task, counted down to `now`; nothing for any other row. */
export function TaskEta({ task, now }: { task: TaskEntry; now: number }): ReactElement | null {
  if (!task.eta || (task.status !== 'running' && task.status !== 'waiting')) {
    return null;
  }
  const { text, tip } = etaText(task.eta, now);
  return (
    <Tooltip title={tip}>
      <Typography component="span" variant="caption" color="text.secondary">
        {text}
      </Typography>
    </Tooltip>
  );
}

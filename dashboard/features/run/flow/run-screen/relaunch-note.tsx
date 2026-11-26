import type { ReactElement } from 'react';
import Typography from '@mui/material/Typography';
import type { FlowView } from '@contract/api';
import { relaunchLine } from '../../relaunch-words';

/** Under the state word: why the steps of a rebased run run again, while the latest relaunch has not finished. */
export function RelaunchNote({ flow }: { flow: FlowView }): ReactElement | null {
  const relaunch = flow.relaunches?.at(-1);
  return relaunch?.open ? (
    <Typography variant="body2" color="text.secondary">
      {relaunchLine(relaunch, ' · ')}
    </Typography>
  ) : null;
}

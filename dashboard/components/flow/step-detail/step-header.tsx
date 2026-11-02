'use client';

import DataUsage from '@mui/icons-material/DataUsage';
import MemoryIcon from '@mui/icons-material/Memory';
import Paid from '@mui/icons-material/Paid';
import Schedule from '@mui/icons-material/Schedule';
import Speed from '@mui/icons-material/Speed';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { statusColor } from '../../../theme/theme';
import { stepLabel } from '../../../lib/phases';
import { StepMetricKind, stepMetrics } from '../../../lib/step-metrics';
import { shownStatus } from '../../../lib/step-view';
import { StepView } from '../../../lib/types';

const stepMetricIcon: Partial<Record<StepMetricKind, typeof Schedule>> = {
  duration: Schedule,
  spend: Paid,
  'tokens-in': DataUsage,
  'tokens-out': DataUsage,
  cpu: Speed,
  memory: MemoryIcon,
};

export function StepHeader({
  step,
  runStatus,
  onReplay,
  onResume,
  view,
  attempt,
  setAttempt,
  follow,
  attempts,
  visit,
  label,
  shownDuration,
  shownAttempt,
}: {
  step: string;
  runStatus?: string;
  onReplay?: () => void;
  onResume?: () => void;
  view: StepView;
  attempt: number;
  setAttempt: (value: number) => void;
  follow: { current: boolean };
  attempts: number;
  visit: StepView['visits'][number] | undefined;
  label: string;
  shownDuration: number;
  shownAttempt: number;
}) {
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontFamily: 'var(--font-mono)' }}>{stepLabel(step)}</Typography>
          {!step.startsWith('code-review-') && (runStatus === 'failed' || runStatus === 'blocked') ? (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: statusColor(runStatus) }}>{runStatus}</Typography>
          ) : null}
          {onReplay && step !== 'done' ? (
            <Button size="small" variant="contained" onClick={onReplay}>
              Run again
            </Button>
          ) : null}
          {onResume ? (
            <Button size="small" variant="contained" onClick={onResume}>
              Resume
            </Button>
          ) : null}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {(view.visits.length > 1 || attempts > 0) && view.visits.map((item, index) => {
            const color = statusColor(shownStatus(item.status, index === view.visits.length - 1, runStatus, step, item.decision));
            return (
              <Button
                key={item.id}
                size="small"
                variant={index === attempt ? 'contained' : 'text'}
                onClick={() => {
                  follow.current = index === view.visits.length - 1;
                  setAttempt(index);
                }}
                sx={index === attempt ? { bgcolor: color, '&:hover': { bgcolor: color } } : { color }}
              >
                {item.attempt}
              </Button>
            );
          })}
        </Box>
      </Box>
      {visit ? (
        <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 2, rowGap: 0.75, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'text.secondary' }}>
          {stepMetrics({
            status: label,
            attempt: shownAttempt,
            durationMs: shownDuration,
            tokensIn: visit.tokensIn,
            tokensOut: visit.tokensOut,
            usd: visit.usd,
            cpuAvg: visit.cpuAvg,
            cpuPeak: visit.cpuPeak,
            memAvg: visit.memAvg,
            memPeak: visit.memPeak,
          }).map((item) => {
            const Icon = stepMetricIcon[item.kind];
            return (
              <Tooltip key={item.tip} title={item.tip}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: item.kind === 'status' ? statusColor(label) : undefined }}>
                  {Icon ? <Icon sx={{ fontSize: 16 }} /> : null}
                  {item.text}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      ) : (
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          This step has not run.
        </Typography>
      )}
    </>
  );
}

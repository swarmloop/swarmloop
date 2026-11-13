'use client';

import type { ReactElement } from 'react';
import DataUsage from '@mui/icons-material/DataUsage';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import MemoryIcon from '@mui/icons-material/Memory';
import Paid from '@mui/icons-material/Paid';
import Schedule from '@mui/icons-material/Schedule';
import Speed from '@mui/icons-material/Speed';
import Undo from '@mui/icons-material/Undo';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { duration } from '../../../../lib/format';
import { statusColor } from '../../../../theme/theme';
import { AttemptSelector } from '../../attempt-selector';
import { stepLabel } from '../../phases';
import { problemId } from '../../transcript/problem-card';
import { problemsLabel } from '../../transcript/transcript-feed';
import type { StepMetricKind } from '../../step-metrics';
import { stepMetrics } from '../../step-metrics';
import type { commandSummary } from '../../check-commands';
import { shownStatus } from '../../step-view';
import type { StepDescriptor, StepView } from '@contract/api';

/** A wait between two steps is shown from this long on. */
const PREPARED_SHOWN_MS = 30_000;

const stepMetricIcon: Partial<Record<StepMetricKind, typeof Schedule>> = {
  duration: Schedule,
  spend: Paid,
  'tokens-in': DataUsage,
  'tokens-out': DataUsage,
  cpu: Speed,
  memory: MemoryIcon,
};

/** `<runtime> · <model>` for an agent step, `server` for a server step, and the reviewers of code review. */
function describe({ kind, agent, reviewers }: StepDescriptor): string {
  const parts: string[] = [];
  if (agent) {
    parts.push(agent.runtime, agent.model);
  } else if (kind === 'server') {
    parts.push('server');
  }
  if (reviewers) {
    parts.push(`reviewers: ${reviewers.map((item) => item.name).join(', ')}`);
  }
  return parts.join(' · ');
}

export function StepHeader({
  step,
  runStatus,
  onReplay,
  onResume,
  resumeLabel = 'Resume',
  view,
  attempt,
  setAttempt,
  follow,
  attempts,
  visit,
  label,
  shownDuration,
  shownAttempt,
  problemId: problem,
  problemCount,
  commands,
  preparing = false,
  slowestPrepared = null,
}: {
  step: string;
  runStatus?: string;
  onReplay?: () => void;
  onResume?: () => void;
  resumeLabel?: string;
  view: StepView;
  attempt: number;
  setAttempt: (value: number) => void;
  follow: { current: boolean };
  attempts: number;
  visit: StepView['visits'][number] | undefined;
  label: string;
  shownDuration: number;
  shownAttempt: number;
  /** The `eventId` of the first problem the step recorded. */
  problemId: string | null;
  /** How many problems the step recorded: the number the transcript chip shows. */
  problemCount: number;
  /** The checks step: how many commands passed, and which one took longest. */
  commands?: ReturnType<typeof commandSummary>;
  /** This step is the one the run works on, and it has not recorded a visit yet. */
  preparing?: boolean;
  /** The slowest server command between the previous visit's end and this visit's first event. */
  slowestPrepared?: { command: string; ms: number } | null;
}): ReactElement {
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Typography sx={{ fontFamily: 'var(--font-mono)' }}>{stepLabel(step)}</Typography>
          {!step.startsWith('code-review-') && (runStatus === 'failed' || runStatus === 'blocked') ? (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: statusColor(runStatus) }}>
              {runStatus}
            </Typography>
          ) : null}
          {onReplay && step !== 'done' ? (
            <Button size="small" variant="contained" onClick={onReplay}>
              Run again
            </Button>
          ) : null}
          {onResume ? (
            <Button size="small" variant="contained" onClick={onResume}>
              {resumeLabel}
            </Button>
          ) : null}
        </Box>
        {view.visits.length > 1 || attempts > 0 ? (
          <AttemptSelector
            items={view.visits.map((item, index) => {
              const status = shownStatus(item.status, index === view.visits.length - 1, runStatus, step, item.decision);
              return {
                key: item.key,
                label: String(item.attempt),
                color: statusColor(status),
                menuText: `${item.attempt} · ${status} · ${duration(item.durationMs)}`,
              };
            })}
            selected={view.visits[attempt]?.key}
            onSelect={(key) => {
              const index = view.visits.findIndex((item) => item.key === key);
              follow.current = index === view.visits.length - 1;
              setAttempt(index);
            }}
          />
        ) : null}
      </Box>
      <Typography sx={{ mt: 0.5, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'text.secondary' }}>
        {describe(view.descriptor)}
      </Typography>
      {commands ? (
        <Typography sx={{ mt: 0.5, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          {commands.passed}/{commands.total} passed
          {commands.slowest ? ` · slowest: ${commands.slowest.command} ${duration(commands.slowest.ms)}` : ''}
        </Typography>
      ) : null}
      {problem ? (
        <Link
          href={`#${problemId(problem)}`}
          underline="always"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById(problemId(problem))?.scrollIntoView({ block: 'center' });
          }}
          sx={{ fontSize: 13, color: 'error.main', display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
        >
          <ErrorOutline sx={{ fontSize: 16 }} />
          {problemsLabel(problemCount)}
        </Link>
      ) : null}
      {visit ? (
        <Box
          sx={{
            mt: 1.5,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: 2,
            rowGap: 0.75,
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'text.secondary',
          }}
        >
          {visit.preparedMs && visit.preparedMs > PREPARED_SHOWN_MS ? (
            <Box component="span">
              prepared in {duration(visit.preparedMs)}
              {slowestPrepared ? ` · slowest: ${slowestPrepared.command} ${duration(slowestPrepared.ms)}` : ''}
            </Box>
          ) : null}
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
            const Icon = item.kind === 'status' && label === 'returned' ? Undo : stepMetricIcon[item.kind];
            return (
              <Tooltip key={item.tip} title={item.tip}>
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    color: item.kind === 'status' ? statusColor(label) : undefined,
                  }}
                >
                  {Icon ? <Icon sx={{ fontSize: 16 }} /> : null}
                  {item.text}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      ) : (
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          {preparing ? 'preparing' : 'This step has not run.'}
        </Typography>
      )}
    </>
  );
}

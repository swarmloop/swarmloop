'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import DataUsage from '@mui/icons-material/DataUsage';
import MemoryIcon from '@mui/icons-material/Memory';
import Paid from '@mui/icons-material/Paid';
import Schedule from '@mui/icons-material/Schedule';
import Speed from '@mui/icons-material/Speed';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { duration, memory, money, tokens } from '../../../../lib/format';
import { latestPhaseLabels } from '../../phases';
import { RunStateLabel } from '../../run-state-label';
import type { FlowView } from '@contract/api';
import { statusColor } from '../../../../theme/theme';

export function RunHeader({
  flow,
  openMs,
  rebasing,
  stopping,
  rebaseError,
  onRebase,
  onStop,
}: {
  flow: FlowView;
  openMs: number;
  rebasing: boolean;
  stopping: boolean;
  rebaseError: string | null;
  onRebase: () => void;
  onStop: () => void;
}): ReactElement {
  const metric = flow.metrics;
  const epic = flow.epic;
  const metricItems: { Icon?: typeof Schedule; text: string; tip: string; color?: string }[] = [
    { text: metric.status, tip: 'Run status', color: statusColor(metric.status) },
    {
      Icon: Schedule,
      text: epic
        ? `${duration(epic.durationMs)} total · ${duration(metric.durationMs + openMs)} this run`
        : duration(metric.durationMs + openMs),
      tip: 'Total time the steps have run. Reviewers that run together count as the slowest one, then the report and the remaining time in that step. Time waiting on a person, and time sitting idle after a failure, is not included.',
    },
    {
      Icon: Paid,
      text: epic ? `${money(epic.usd)} total · ${money(metric.usd)} this run` : money(metric.usd),
      tip: 'Session spend',
    },
    { Icon: DataUsage, text: `${tokens(metric.tokens)} tok`, tip: 'Session tokens' },
    { Icon: Speed, text: `cpu ${metric.cpuPeak.toFixed(0)}%`, tip: 'Highest CPU in the session' },
    { Icon: MemoryIcon, text: `mem ${memory(metric.memPeak)}`, tip: 'Highest memory in the session' },
  ];
  const launches = flow.launches ?? [];
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ minWidth: 0, overflow: 'hidden' }}>
          <Tooltip title={flow.name}>
            <Typography variant="h5" noWrap>
              {flow.name}
            </Typography>
          </Tooltip>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} color="text.secondary">
              {flow.key}
            </Typography>
            {flow.startedBy ? (
              <Typography variant="body2" color="text.secondary">
                Started by {flow.startedBy}
              </Typography>
            ) : null}
            {flow.projects.map((project) => (
              <Chip
                key={project}
                size="small"
                variant="outlined"
                label={project}
                sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            ))}
            {flow.workspace === 'removed' ? (
              <Chip size="small" variant="outlined" label="workspace removed" sx={{ height: 22, fontSize: 12 }} />
            ) : null}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {flow.actions.includes('rebase') ? (
            <Button variant="outlined" disabled={rebasing} onClick={onRebase}>
              Rebase
            </Button>
          ) : null}
          {flow.actions.includes('stop') ? (
            <Button color="error" variant="outlined" disabled={stopping} onClick={onStop}>
              Stop
            </Button>
          ) : null}
          <Button component={Link} href={`/runs/${flow.key}/history` as Route} color="inherit">
            All history
          </Button>
        </Box>
      </Box>
      {rebaseError ? (
        <Typography color="error" variant="body2" sx={{ mt: 1 }}>
          {rebaseError}
        </Typography>
      ) : null}
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
        {metricItems.map(({ Icon, text, tip, color }) => (
          <Tooltip key={tip} title={tip}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color }}>
              {Icon ? <Icon sx={{ fontSize: 16 }} /> : null}
              {text}
            </Box>
          </Tooltip>
        ))}
      </Box>
      {flow.status === 'done' ? (
        <Box sx={{ mt: 0.75 }}>
          <RunStateLabel status={flow.status} merge={flow.merge} />
        </Box>
      ) : null}
      {launches.length > 0 ? (
        <Box sx={{ mt: 0.75, display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {latestPhaseLabels(launches).map((label) => (
            <Chip
              key={label}
              size="small"
              variant="outlined"
              label={label}
              sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }}
            />
          ))}
        </Box>
      ) : null}
    </>
  );
}

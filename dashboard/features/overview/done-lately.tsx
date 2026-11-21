'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import type { RunSummary } from '@contract/api';
import { nested } from '@contract/run-list';
import { getFlow } from '../../lib/endpoints';
import { money } from '../../lib/format';
import { RunStateIcon, runWord } from '../run';
import { longDuration, returnsWords } from './overview-format';
import { useOverviewRuns } from './use-overview-runs';

const SHOWN = 5;

function DoneLine({ run }: { run: RunSummary }): ReactElement {
  const flow = useQuery({ queryKey: ['overview-flow', run.key], queryFn: () => getFlow(run.key) });
  const totals = run.epic ?? { durationMs: run.durationMs, usd: run.usd };
  const returns = (flow.data?.returns ?? []).reduce((sum, item) => sum + item.count, 0);
  const request = flow.data?.mergeRequests[0];
  const view = runWord(run);
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Box
        component={Link}
        href={`/runs/${encodeURIComponent(run.key)}` as Route}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flex: 1,
          minWidth: 0,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        <RunStateIcon view={view} />
        <Typography noWrap sx={{ flex: 1 }}>
          {run.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {longDuration(totals.durationMs)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {money(totals.usd)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {flow.data ? returnsWords(returns, run.state === 'done' || run.state === 'merged') : ''}
        </Typography>
      </Box>
      {request ? (
        <a href={request.url} target="_blank" rel="noreferrer">
          Merge request
        </a>
      ) : null}
    </Box>
  );
}

/** The last five finished top-level runs, one line each. */
export function DoneLately(): ReactElement | null {
  const { done } = useOverviewRuns();
  const lines = nested(done).tops.slice(0, SHOWN);
  if (lines.length === 0) {
    return null;
  }
  return (
    <Box component="section" aria-label="Done lately" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" component="h2">
        Done lately
      </Typography>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {lines.map((run) => (
          <DoneLine key={run.key} run={run} />
        ))}
      </Box>
    </Box>
  );
}

'use client';

import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { StatsTotals } from '@contract/api';
import { CHART, OUTCOMES } from './chart-parts';
import { big, hours, percent, usd } from './stats-format';

function Tile({ label, value, children }: { label: string; value: string; children?: ReactNode }): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }} aria-label={`${label}: ${value}`}>
      <Typography variant="body2" color="text.secondary" noWrap>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.2, mt: 0.25 }}>
        {value}
      </Typography>
      <Box sx={{ mt: 0.5, fontSize: 13, color: 'text.secondary', minHeight: 20 }}>{children}</Box>
    </Paper>
  );
}

/** A thin bar split by outcome, so the share of each reads at a glance. Labels sit under it. */
function OutcomeBar({ totals }: { totals: StatsTotals }): ReactElement {
  const parts = OUTCOMES.filter(({ outcome }) => totals[outcome] > 0);
  return (
    <Box>
      <Box
        sx={{ display: 'flex', gap: '2px', height: 6, borderRadius: 3, overflow: 'hidden', bgcolor: 'action.hover' }}
      >
        {parts.map(({ outcome }) => (
          <Box key={outcome} sx={{ flex: totals[outcome], bgcolor: CHART[outcome] }} />
        ))}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.25, mt: 0.75 }}>
        {OUTCOMES.map(({ outcome, label }) => (
          <span key={outcome}>
            <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
              {totals[outcome]}
            </Box>{' '}
            {label.toLowerCase()}
          </span>
        ))}
      </Box>
    </Box>
  );
}

export function StatTiles({ totals }: { totals: StatsTotals }): ReactElement {
  const finished = totals.done + totals.failed;
  const returns = totals.reviewReturns + totals.pipelineReturns;
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'repeat(2, minmax(0, 1fr))',
          md: 'repeat(3, minmax(0, 1fr))',
          xl: 'repeat(6, minmax(0, 1fr))',
        },
        gap: 2,
      }}
    >
      <Tile label="Runs" value={String(totals.runs)}>
        <OutcomeBar totals={totals} />
      </Tile>
      <Tile label="Success rate" value={percent(totals.done, finished)}>
        {finished > 0 ? `${totals.done} of ${finished} finished runs` : 'no run has finished'}
      </Tile>
      <Tile label="First-pass rate" value={percent(totals.firstPass, totals.done)}>
        {totals.done > 0 ? `${totals.firstPass} done runs never went back` : 'no run is done'}
      </Tile>
      <Tile label="Spend" value={usd(totals.usd)}>
        {totals.done > 0 ? `${usd(totals.usd / totals.done)} per done run` : 'no run is done'}
      </Tile>
      <Tile label="Returns" value={String(returns)}>
        {totals.runs > 0 ? `${(returns / totals.runs).toFixed(1)} per run · ${totals.pipelineReturns} from CI` : '—'}
      </Tile>
      <Tile label="Agent time" value={hours(totals.agentMs)}>
        {totals.medianDoneMs !== null
          ? `median run ${hours(totals.medianDoneMs)}`
          : `${big(totals.tokensIn + totals.tokensOut)} tokens`}
      </Tile>
      <Tile label="Usage limits" value={String(totals.limits)}>
        {totals.limits > 0 ? 'launches that hit a provider limit' : 'no launch hit a provider limit'}
      </Tile>
    </Box>
  );
}

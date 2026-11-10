'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { getStats } from '../../lib/endpoints';
import { MoneyBreakdown, Returns } from './money-and-returns';
import { RunsPerDay } from './runs-per-day';
import { SpendPerDay } from './spend-per-day';
import { StatTiles } from './stat-tiles';
import { dayLabel } from './stats-format';
import { TopRuns } from './top-runs';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'All time' },
];

/**
 * Statistics of the runs started in the chosen range. `version` changes when a run starts, ends or changes status,
 * so the numbers follow the live list without polling.
 */
export function StatsSection({ version }: { version: string }): ReactElement {
  const [days, setDays] = useState(30);
  const [day, setDay] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['stats', days, version],
    queryFn: () => getStats(days, localOffset()),
    placeholderData: keepPreviousData,
  });
  const stats = query.data;

  return (
    <Box component="section" aria-label="Statistics" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={days}
          onChange={(_, next: number | null) => {
            if (next !== null) {
              setDays(next);
              setDay(null);
            }
          }}
          aria-label="Range"
        >
          {RANGES.map((range) => (
            <ToggleButton key={range.days} value={range.days} sx={{ px: 1.5 }}>
              {range.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {stats ? (
          <Typography variant="body2" color="text.secondary">
            runs started {dayLabel(stats.from)} – {dayLabel(stats.to)}
          </Typography>
        ) : null}
      </Box>
      {query.error ? (
        <Alert severity="warning">
          Statistics are not available: {query.error instanceof Error ? query.error.message : 'api is not reachable'}
        </Alert>
      ) : null}
      {!stats && !query.error ? <Loading /> : null}
      {stats ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            opacity: query.isPlaceholderData ? 0.6 : 1,
            transition: 'opacity 200ms',
          }}
        >
          <StatTiles totals={stats.totals} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '7fr 5fr' }, gap: 2 }}>
            <RunsPerDay days={stats.days} total={stats.totals} selected={day} onSelect={setDay} />
            <SpendPerDay days={stats.days} total={stats.totals.usd} />
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
            <MoneyBreakdown stats={stats} />
            <Returns stats={stats} />
          </Box>
          <TopRuns runs={stats.runs} day={day} onClearDay={() => setDay(null)} />
        </Box>
      ) : null}
    </Box>
  );
}

/** Minutes this browser is behind UTC now, as the server wants them for local days. */
function localOffset(): number {
  return new Date(Date.now()).getTimezoneOffset();
}

function Loading(): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-busy="true">
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', xl: 'repeat(6, 1fr)' }, gap: 2 }}>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <Skeleton key={index} variant="rounded" height={112} />
        ))}
      </Box>
      <Skeleton variant="rounded" height={300} />
    </Box>
  );
}

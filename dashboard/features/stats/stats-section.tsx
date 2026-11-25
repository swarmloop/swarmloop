'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { getStats } from '../../lib/endpoints';
import { MergeShare, TimeToMerge } from './merge-charts';
import { MoneyBreakdown, Returns } from './money-and-returns';
import { UnitsPerDay } from './runs-per-day';
import { SpendPerDay } from './spend-per-day';
import { StallsPerDay } from './stalls-per-day';
import { StatTiles, TILE_COLUMNS } from './stat-tiles';
import { dayLabel } from './stats-format';
import { TopRuns } from './top-runs';
import { UnitFigures } from './unit-figures';

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
  const [pick, setPick] = useState<{ day: string; unit: 'epics' | 'tasks' } | null>(null);
  const pickOn = (unit: 'epics' | 'tasks') => (day: string | null) => setPick(day === null ? null : { day, unit });
  const query = useQuery({
    queryKey: ['stats', days, version],
    queryFn: () => getStats(days, localOffset()),
    placeholderData: keepPreviousData,
  });
  const stats = query.data;

  return (
    <Box
      component="section"
      id="statistics"
      aria-label="Statistics"
      sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={days}
          onChange={(_, next: number | null) => {
            if (next !== null) {
              setDays(next);
              setPick(null);
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
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
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
          <UnitFigures epics={stats.epics} tasks={stats.tasks} />
          <StatTiles totals={stats.totals} tasks={stats.tasks} days={stats.days.length} />
          <UnitsPerDay
            unit="tasks"
            days={stats.days}
            total={stats.tasks}
            selected={pick?.unit === 'tasks' ? pick.day : null}
            onSelect={pickOn('tasks')}
          />
          <UnitsPerDay
            unit="epics"
            days={stats.days}
            total={stats.epics}
            selected={pick?.unit === 'epics' ? pick.day : null}
            onSelect={pickOn('epics')}
          />
          <SpendPerDay days={stats.days} totals={stats.totals} tasks={stats.tasks} />
          <StallsPerDay days={stats.days} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
            <MergeShare days={stats.days} totals={stats.totals} />
            <TimeToMerge days={stats.days} totals={stats.totals} />
          </Box>
          <MoneyBreakdown stats={stats} />
          <Returns stats={stats} />
          <TopRuns runs={stats.runs} subtasks={stats.subtasks} pick={pick} onClearDay={() => setPick(null)} />
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
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: `repeat(${TILE_COLUMNS}, 1fr)` },
          gap: 2,
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
          <Skeleton key={index} variant="rounded" height={112} />
        ))}
      </Box>
      <Skeleton variant="rounded" height={300} />
    </Box>
  );
}

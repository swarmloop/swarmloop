'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { StatsView } from '@contract/api';
import { getStats } from '../../lib/endpoints';
import { useStatsVersion } from '../stats';
import { compactCount, wholeDollars } from './overview-format';
import { OVERVIEW_RANGES, useOverviewRange } from './overview-range';

interface Tile {
  label: string;
  href: Route;
  figure: (totals: StatsView['totals']) => string;
}

const TILES: Tile[] = [
  { label: 'Merged', href: '/?show=done', figure: (t) => compactCount(t.merged) },
  {
    label: 'Requirements met',
    href: '/stats#returns',
    figure: (t) => `${compactCount(t.requirementsMet)}/${compactCount(t.requirementsTotal)}`,
  },
  { label: 'Caught and fixed', href: '/stats#returns', figure: (t) => compactCount(t.caughtAndFixed) },
  { label: 'Your input', href: '/?show=done', figure: (t) => compactCount(t.personMessages) },
  { label: 'Cost', href: '/stats', figure: (t) => wholeDollars(t.usd) },
];

function useStatsTotals(days: number, version: string) {
  return useQuery({
    queryKey: ['overview-stats', days, version],
    queryFn: () => getStats(days, new Date(Date.now()).getTimezoneOffset()),
    placeholderData: keepPreviousData,
  });
}

/** The range control and one row of five large figures, each a link to its details. */
export function OverviewNumbers(): ReactElement {
  const [days, setDays] = useOverviewRange();
  const stats = useStatsTotals(days, useStatsVersion()).data;
  return (
    <Box component="section" aria-label="Numbers" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={days}
        onChange={(_, next: number | null) => {
          if (next !== null) {
            setDays(next);
          }
        }}
        aria-label="Range"
        sx={{ alignSelf: 'flex-start' }}
      >
        {OVERVIEW_RANGES.map((range) => (
          <ToggleButton key={range.days} value={range.days} sx={{ px: 1.5 }}>
            {range.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {TILES.map((tile) =>
          stats ? (
            <Box
              key={tile.label}
              component={Link}
              href={tile.href}
              sx={{ color: 'inherit', textDecoration: 'none', minWidth: 0 }}
            >
              <Typography
                component="div"
                variant="body2"
                noWrap
                sx={{ fontSize: 40, lineHeight: 1.2, fontWeight: 600 }}
              >
                {tile.figure(stats.totals)}
              </Typography>
              <Typography component="div" variant="body2" color="text.secondary">
                {tile.label}
              </Typography>
            </Box>
          ) : (
            <Skeleton key={tile.label} variant="rounded" height={72} data-testid="number-placeholder" />
          ),
        )}
      </Box>
    </Box>
  );
}

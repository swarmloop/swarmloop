'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { StatsShare, StatsView } from '@contract/api';
import { BarList, type BarRow } from './bar-list';
import { CHART, ChartCard, MONO } from './chart-parts';
import { big, percent, usd } from './stats-format';

type By = 'steps' | 'models' | 'agents';

const BY: { by: By; label: string; unit: string }[] = [
  { by: 'steps', label: 'Step', unit: 'visits' },
  { by: 'models', label: 'Model', unit: 'calls' },
  { by: 'agents', label: 'Agent', unit: 'runs' },
];

function shareRows(shares: StatsShare[], total: number, unit: string): BarRow[] {
  return shares.map((share) => ({
    name: share.name,
    value: share.usd,
    label: usd(share.usd),
    detail: `${percent(share.usd, total)} of spend · ${share.count} ${unit} · ${big(share.tokens)} tokens`,
  }));
}

/** Where the dollars went: by step, by model, or by agent. */
export function MoneyBreakdown({ stats }: { stats: StatsView }): ReactElement {
  const [by, setBy] = useState<By>('steps');
  const unit = BY.find((entry) => entry.by === by)?.unit ?? '';
  const rows = shareRows(stats[by], stats.totals.usd, unit);
  return (
    <ChartCard
      title="Where the money goes"
      headline={rows[0] ? `${rows[0].name}` : usd(0)}
      note={
        rows[0] ? `${percent(stats[by][0].usd, stats.totals.usd)} of ${usd(stats.totals.usd)}` : 'nothing spent yet'
      }
      action={
        <ToggleButtonGroup
          size="small"
          exclusive
          value={by}
          onChange={(_, next: By | null) => next && setBy(next)}
          aria-label="Group spend by"
        >
          {BY.map((entry) => (
            <ToggleButton key={entry.by} value={entry.by} sx={{ px: 1.25, py: 0.25 }}>
              {entry.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      <BarList
        rows={rows}
        color={CHART.money}
        empty="No agent has spent anything in this range."
        other={(rest) => {
          const value = rest.reduce((sum, row) => sum + row.value, 0);
          return {
            name: `${rest.length} more`,
            value,
            label: usd(value),
            detail: rest.map((row) => row.name).join(', '),
          };
        }}
      />
    </ChartCard>
  );
}

const REASON_NAMES: Record<string, string> = { pipeline: 'CI pipeline' };

/** Who sent work back, and how many times each run went back. */
export function Returns({ stats }: { stats: StatsView }): ReactElement {
  const { totals } = stats;
  const returns = totals.reviewReturns + totals.pipelineReturns;
  const rows: BarRow[] = stats.reasons.map((reason) => ({
    name: REASON_NAMES[reason.name] ?? reason.name,
    value: reason.returns,
    label: String(reason.returns),
    detail:
      reason.name === 'pipeline'
        ? `${reason.returns} times CI failed and the work went back`
        : `${reason.returns} times the ${reason.name} reviewer sent the work back`,
  }));
  const maxRuns = Math.max(...stats.returnsPerRun.map((bucket) => bucket.runs), 1);
  return (
    <ChartCard
      title="Why work came back"
      headline={`${returns} ${returns === 1 ? 'return' : 'returns'}`}
      note={`${totals.reviewReturns} from reviewers · ${totals.pipelineReturns} from CI · ${percent(totals.firstPass, totals.done)} of done runs passed first time`}
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 172px' }, gap: 3, alignItems: 'start' }}>
        <BarList
          rows={rows}
          color={CHART.returns}
          empty="Nothing came back in this range."
          other={(rest) => {
            const value = rest.reduce((sum, row) => sum + row.value, 0);
            return {
              name: `${rest.length} more`,
              value,
              label: String(value),
              detail: rest.map((row) => row.name).join(', '),
            };
          }}
        />
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Returns per run
          </Typography>
          <Box
            sx={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 110 }}
            role="list"
            aria-label="Returns per run"
          >
            {stats.returnsPerRun.map((bucket) => (
              <Tooltip
                key={bucket.returns}
                title={`${bucket.runs} ${bucket.runs === 1 ? 'run' : 'runs'} went back ${bucket.returns === '1' ? 'once' : `${bucket.returns} times`}`}
                placement="top"
                arrow
                disableInteractive
              >
                <Box
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${bucket.returns} returns: ${bucket.runs} runs`}
                  sx={{
                    flex: 1,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: 0.5,
                    outline: 'none',
                    '&:hover .col, &:focus-visible .col': { filter: 'brightness(1.12)' },
                  }}
                >
                  <Typography sx={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {bucket.runs}
                  </Typography>
                  <Box
                    className="col"
                    sx={{
                      width: '100%',
                      height: `${(bucket.runs / maxRuns) * 72}px`,
                      minHeight: bucket.runs > 0 ? 3 : 0,
                      bgcolor: bucket.returns === '0' ? CHART.done : CHART.returns,
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                  <Typography sx={{ fontSize: 11, fontFamily: MONO, color: 'text.secondary' }}>
                    {bucket.returns}
                  </Typography>
                </Box>
              </Tooltip>
            ))}
          </Box>
        </Box>
      </Box>
    </ChartCard>
  );
}

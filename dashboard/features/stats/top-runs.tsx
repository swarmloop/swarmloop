'use client';

import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Typography from '@mui/material/Typography';
import type { StatsRun } from '@contract/api';
import { duration, when } from '../../lib/format';
import { CHART, ChartCard, OUTCOMES } from './chart-parts';
import { longDayLabel, usd } from './stats-format';

const LABEL = Object.fromEntries(OUTCOMES.map(({ outcome, label }) => [outcome, label]));
const SHOWN = 10;

type Column = 'usd' | 'returns' | 'durationMs' | 'createdAt';

const COLUMNS: { column: Column; label: string }[] = [
  { column: 'usd', label: 'Spend' },
  { column: 'returns', label: 'Returns' },
  { column: 'durationMs', label: 'Time' },
  { column: 'createdAt', label: 'Started' },
];

/** The local day a run started on, `YYYY-MM-DD`, as the server counts the days for this browser. */
function startedOn(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function compare(column: Column): (a: StatsRun, b: StatsRun) => number {
  return column === 'createdAt'
    ? (a, b) => a.createdAt.localeCompare(b.createdAt)
    : (a, b) => a[column] - b[column] || a.createdAt.localeCompare(b.createdAt);
}

/** The runs of the range, sortable. With a day picked on the chart, only the runs that started that day. */
export function TopRuns({
  runs,
  day,
  onClearDay,
}: {
  runs: StatsRun[];
  day: string | null;
  onClearDay: () => void;
}): ReactElement {
  const router = useRouter();
  const [sort, setSort] = useState<{ column: Column; desc: boolean }>({ column: 'usd', desc: true });
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const picked = day === null ? runs : runs.filter((run) => startedOn(run.createdAt) === day);
    const sorted = [...picked].sort(compare(sort.column));
    return sort.desc ? sorted.reverse() : sorted;
  }, [runs, day, sort]);
  const shown = all ? rows : rows.slice(0, SHOWN);
  const max = Math.max(...rows.map((run) => run.usd), 1e-9);
  const open = (key: string): void => router.push(`/runs/${encodeURIComponent(key)}`);

  return (
    <ChartCard
      title={day === null ? 'Runs' : `Runs started ${longDayLabel(day)}`}
      note={
        day === null
          ? 'click a day on the runs chart to see only its runs · click a run to open it'
          : `${rows.length} ${rows.length === 1 ? 'run' : 'runs'} · click a run to open it`
      }
      action={
        day === null ? null : <Chip label="Show every day" onDelete={onClearDay} onClick={onClearDay} size="small" />
      }
    >
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No run started {day === null ? 'in this range' : 'that day'}.
        </Typography>
      ) : (
        <Box sx={{ overflowX: 'auto', mx: -1 }}>
          <Table size="small" sx={{ '& td, & th': { borderColor: 'divider', px: 1 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Run</TableCell>
                <TableCell>Status</TableCell>
                {COLUMNS.map(({ column, label }) => (
                  <TableCell
                    key={column}
                    align={column === 'usd' ? 'left' : 'right'}
                    sx={column === 'usd' ? { width: '26%' } : undefined}
                    sortDirection={sort.column === column ? (sort.desc ? 'desc' : 'asc') : false}
                  >
                    <TableSortLabel
                      active={sort.column === column}
                      direction={sort.column === column && !sort.desc ? 'asc' : 'desc'}
                      onClick={() =>
                        setSort((current) => ({ column, desc: current.column === column ? !current.desc : true }))
                      }
                    >
                      {label}
                    </TableSortLabel>
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((run) => (
                <TableRow
                  key={run.key}
                  hover
                  tabIndex={0}
                  onClick={() => open(run.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      open(run.key);
                    }
                  }}
                  sx={{ cursor: 'pointer', '&:last-child td': { border: 0 } }}
                >
                  <TableCell sx={{ maxWidth: 360 }}>
                    <Typography noWrap sx={{ fontSize: 14, fontWeight: 500 }} title={run.name}>
                      {run.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box
                      component="span"
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}
                    >
                      <Box
                        component="span"
                        sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: CHART[run.outcome] }}
                      />
                      {run.outcome === 'active' ? run.status : LABEL[run.outcome]}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box sx={{ flex: 1, height: 6, minWidth: 40 }}>
                        <Box
                          sx={{
                            width: `${(run.usd / max) * 100}%`,
                            height: '100%',
                            bgcolor: CHART.money,
                            borderRadius: '0 3px 3px 0',
                          }}
                        />
                      </Box>
                      <Typography
                        sx={{
                          fontSize: 13,
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          minWidth: 56,
                          textAlign: 'right',
                        }}
                      >
                        {usd(run.usd)}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {run.returns}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {run.durationMs > 0 ? duration(run.durationMs) : '—'}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                    {when(run.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length > SHOWN ? (
            <Box sx={{ px: 1, pt: 1 }}>
              <Button size="small" onClick={() => setAll((current) => !current)}>
                {all ? 'Show fewer' : `Show all ${rows.length}`}
              </Button>
            </Box>
          ) : null}
        </Box>
      )}
    </ChartCard>
  );
}

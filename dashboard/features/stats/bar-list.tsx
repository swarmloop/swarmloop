'use client';

import { Fragment, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { MONO } from './chart-parts';

export interface BarRow {
  name: string;
  value: number;
  /** The value as the row shows it. */
  label: string;
  /** What the tooltip adds: share, counts, tokens. */
  detail: string;
  /** What the bar opens to: smaller rows under it, as name and value. */
  parts?: { name: string; label: string }[];
}

/** Ranked horizontal bars. Past `limit` rows the rest fold into one `other` row, so no hue or row is invented. */
export function BarList({
  rows,
  color,
  limit = 8,
  other,
  empty,
}: {
  rows: BarRow[];
  color: string;
  limit?: number;
  other: (rest: BarRow[]) => BarRow;
  empty: string;
}): ReactElement {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {empty}
      </Typography>
    );
  }
  const shown = rows.length > limit ? [...rows.slice(0, limit - 1), other(rows.slice(limit - 1))] : rows;
  const max = Math.max(...shown.map((row) => row.value), 1e-9);
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {shown.map((row) => (
        <Fragment key={row.name}>
          <Tooltip title={row.detail} placement="top" arrow disableInteractive>
            <Box
              component="li"
              tabIndex={0}
              aria-label={`${row.name}: ${row.label}, ${row.detail}`}
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(96px, 36%) 1fr auto',
                alignItems: 'center',
                columnGap: 1.5,
                py: 0.5,
                px: 0.75,
                mx: -0.75,
                borderRadius: 1,
                outline: 'none',
                '&:hover, &:focus-visible': { bgcolor: 'action.hover' },
                '&:hover .bar, &:focus-visible .bar': { filter: 'brightness(1.12)' },
              }}
            >
              <Typography noWrap sx={{ fontFamily: MONO, fontSize: 12.5, color: 'text.secondary' }}>
                {row.name}
              </Typography>
              <Box sx={{ height: 10, position: 'relative' }}>
                <Box
                  className="bar"
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    width: `${Math.max((row.value / max) * 100, row.value > 0 ? 1.5 : 0)}%`,
                    bgcolor: color,
                    borderRadius: '0 4px 4px 0',
                    transition: 'width 300ms ease',
                  }}
                />
              </Box>
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                  minWidth: 52,
                }}
              >
                {row.label}
              </Typography>
            </Box>
          </Tooltip>
          {row.parts ? (
            <Box component="li" sx={{ listStyle: 'none', pl: 1.5, mt: -0.25 }}>
              {row.parts.map((part) => (
                <Box key={part.name} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, fontSize: 12 }}>
                  <Typography noWrap sx={{ fontFamily: MONO, fontSize: 12, color: 'text.secondary' }}>
                    {part.name}
                  </Typography>
                  <Typography sx={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{part.label}</Typography>
                </Box>
              ))}
            </Box>
          ) : null}
        </Fragment>
      ))}
    </Box>
  );
}

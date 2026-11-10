'use client';

import type { ReactElement, ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { RunOutcome } from '@contract/api';

/** The chart colors live in the theme as CSS variables, one set per mode. */
export const CHART = {
  done: 'var(--chart-done)',
  active: 'var(--chart-active)',
  failed: 'var(--chart-failed)',
  money: 'var(--chart-money)',
  returns: 'var(--chart-returns)',
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
} as const;

export const OUTCOMES: { outcome: RunOutcome; label: string }[] = [
  { outcome: 'done', label: 'Done' },
  { outcome: 'active', label: 'In progress' },
  { outcome: 'failed', label: 'Failed' },
];

export const MONO = 'var(--font-mono), ui-monospace, monospace';

/** The width of an element, followed as it resizes. Before the first measure, and without ResizeObserver, `fallback`. */
export function useWidth<T extends HTMLElement>(fallback = 640): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const update = (): void => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width > 0 ? width : fallback];
}

export function ChartCard({
  title,
  headline,
  note,
  legend,
  action,
  children,
}: {
  title: string;
  headline?: ReactNode;
  note?: ReactNode;
  legend?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={title}
      sx={{ p: { xs: 2, md: 2.5 }, height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 500 }}>
            {title}
          </Typography>
          {headline ? (
            <Typography sx={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.25 }}>
              {headline}
            </Typography>
          ) : null}
          {note ? (
            <Typography variant="body2" color="text.secondary">
              {note}
            </Typography>
          ) : null}
        </Box>
        {action}
      </Box>
      {legend}
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Paper>
  );
}

/** A legend entry: a swatch shaped like the mark (`bar` or `line`), the name, and an optional value after it. */
export function LegendItem({
  color,
  label,
  value,
  shape = 'bar',
}: {
  color: string;
  label: string;
  value?: string;
  shape?: 'bar' | 'line';
}): ReactElement {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 13 }}>
      <Box
        component="span"
        sx={
          shape === 'bar'
            ? { width: 10, height: 10, borderRadius: '3px', bgcolor: color, flexShrink: 0 }
            : { width: 16, height: 0, borderTop: `2px solid ${color}`, flexShrink: 0 }
        }
      />
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}
      </Box>
      {value ? (
        <Box component="span" sx={{ fontWeight: 600, color: 'text.primary', fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </Box>
      ) : null}
    </Box>
  );
}

export function Legend({ children }: { children: ReactNode }): ReactElement {
  return <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5 }}>{children}</Box>;
}

/** A tooltip row: a short stroke of the series color, the value strong, the name after it. */
export function TipRow({ color, value, label }: { color?: string; value: string; label: string }): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 13, lineHeight: 1.6 }}>
      {color ? (
        <Box component="span" sx={{ width: 12, height: 0, borderTop: `2px solid ${color}`, flexShrink: 0 }} />
      ) : null}
      <Box component="span" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Box>
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}
      </Box>
    </Box>
  );
}

/** The one tooltip of a chart, placed beside the hovered point and kept inside the chart. */
export function ChartTip({
  x,
  y,
  width,
  title,
  children,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  children: ReactNode;
}): ReactElement {
  const flip = x > width - 190;
  return (
    <Paper
      role="tooltip"
      elevation={6}
      sx={{
        position: 'absolute',
        top: Math.max(0, y),
        left: flip ? undefined : x + 14,
        right: flip ? width - x + 14 : undefined,
        pointerEvents: 'none',
        px: 1.5,
        py: 1,
        minWidth: 150,
        border: 1,
        borderColor: 'divider',
        zIndex: 2,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

/** A bar with a rounded end away from the baseline: the top for a vertical bar, the right for a horizontal one. */
export function roundedTop(x: number, y: number, width: number, height: number, radius = 4): string {
  const r = Math.min(radius, width / 2, height);
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${y + height}`,
    'Z',
  ].join(' ');
}

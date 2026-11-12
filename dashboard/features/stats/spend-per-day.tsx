'use client';

import type { PointerEvent, ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import type { StatsDay, StatsTotals } from '@contract/api';
import { CHART, ChartCard, ChartTip, MONO, TipRow, useWidth } from './chart-parts';
import { dayLabel, longDayLabel, ticks, usd } from './stats-format';

const HEIGHT = 220;
const PAD = { top: 10, right: 12, bottom: 26, left: 48 };

/** Dollars spent each day, with a crosshair that snaps to the nearest day. */
export function SpendPerDay({ days, totals }: { days: StatsDay[]; totals: StatsTotals }): ReactElement {
  const total = totals.usd;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const axis = ticks(Math.max(...days.map((day) => day.usd), 1));
  const top = axis[axis.length - 1];
  const step = days.length > 1 ? plotWidth / (days.length - 1) : 0;
  const x = (index: number): number => (days.length > 1 ? PAD.left + index * step : PAD.left + plotWidth / 2);
  const y = (value: number): number => PAD.top + plotHeight - (value / top) * plotHeight;
  const line = days.map((day, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(day.usd)}`).join(' ');
  const area = days.length > 0 ? `${line} L${x(days.length - 1)},${y(0)} L${x(0)},${y(0)} Z` : '';
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 64))));
  const last = days.length - 1;
  // The last day always has its label: a regular label that would touch it gives way.
  const labelled = (index: number): boolean =>
    index === last || (index % labelEvery === 0 && last - index >= labelEvery * 0.75);
  const anchor = (index: number): 'start' | 'end' | 'middle' =>
    index === 0 && last > 0 ? 'start' : index === last && last > 0 ? 'end' : 'middle';
  const spending = days.filter((day) => day.usd > 0);
  const peak = spending.reduce<StatsDay | null>(
    (best, day) => (best === null || day.usd > best.usd ? day : best),
    null,
  );
  const hovered = hover === null ? null : days[hover];

  function track(event: PointerEvent<SVGRectElement>): void {
    const left = event.currentTarget.getBoundingClientRect().left;
    const index = step > 0 ? Math.round((event.clientX - left) / step) : 0;
    setHover(Math.min(Math.max(index, 0), days.length - 1));
  }

  return (
    <ChartCard
      title="Spend"
      headline={`${usd(total)} in ${days.length} ${days.length === 1 ? 'day' : 'days'}`}
      note={
        peak
          ? `${usd(total / spending.length)} per working day · ${usd(totals.usdPerTask)} per task (median ${usd(totals.medianUsdPerTask)}) · peak ${usd(peak.usd)} on ${dayLabel(peak.day)}`
          : 'nothing spent yet'
      }
    >
      <Box ref={ref} sx={{ position: 'relative' }} onPointerLeave={() => setHover(null)}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Spend per day, ${usd(total)} in ${days.length} ${days.length === 1 ? 'day' : 'days'}`}
          style={{ display: 'block' }}
        >
          <defs>
            <linearGradient id="spend-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={CHART.money} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART.money} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {axis.map((value) => (
            <g key={value}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} stroke={CHART.grid} />
              <text
                x={PAD.left - 8}
                y={y(value)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fontFamily={MONO}
                fill={CHART.axis}
              >
                {usd(value)}
              </text>
            </g>
          ))}
          {days.map((day, index) =>
            labelled(index) ? (
              <text
                key={day.day}
                x={x(index)}
                y={HEIGHT - 8}
                textAnchor={anchor(index)}
                fontSize={11}
                fontFamily={MONO}
                fill={CHART.axis}
              >
                {dayLabel(day.day)}
              </text>
            ) : null,
          )}
          <path d={area} fill="url(#spend-fill)" />
          <path
            d={line}
            fill="none"
            stroke={CHART.money}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {days.length === 1 ? <circle cx={x(0)} cy={y(days[0].usd)} r={4} fill={CHART.money} /> : null}
          {hovered && hover !== null ? (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} stroke={CHART.axis} strokeDasharray="3 3" />
              <circle
                cx={x(hover)}
                cy={y(hovered.usd)}
                r={5}
                fill={CHART.money}
                stroke="var(--mui-palette-background-paper)"
                strokeWidth={2}
              />
            </g>
          ) : null}
          <rect
            x={PAD.left - step / 2}
            y={PAD.top}
            width={plotWidth + step}
            height={plotHeight}
            fill="transparent"
            data-testid="spend-hit"
            onPointerMove={track}
            onPointerEnter={track}
          />
        </svg>
        {hovered && hover !== null ? (
          <ChartTip
            x={x(hover)}
            y={Math.max(PAD.top, y(hovered.usd) - 40)}
            width={width}
            title={longDayLabel(hovered.day)}
          >
            <TipRow color={CHART.money} value={usd(hovered.usd)} label="spent" />
            <TipRow value={String(hovered.done + hovered.active + hovered.failed)} label="runs started" />
            <TipRow value={String(hovered.returns)} label="returns" />
          </ChartTip>
        ) : null}
      </Box>
    </ChartCard>
  );
}

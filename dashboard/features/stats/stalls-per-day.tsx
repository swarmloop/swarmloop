'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import type { StatsDay } from '@contract/api';
import { STALL_KIND_WORDS, type ServerStallKind } from '@contract/server-stall';
import { CHART, ChartCard, ChartTip, Legend, LegendItem, TipRow, roundedTop, useWidth } from './chart-parts';
import { dayLabel, longDayLabel, ticks } from './stats-format';

const HEIGHT = 180;
const PAD = { top: 10, right: 8, bottom: 26, left: 34 };
const GAP = 2;

const KINDS: { kind: ServerStallKind; color: string }[] = [
  { kind: 'server-blocked', color: CHART.failed },
  { kind: 'host-paused', color: CHART.active },
];

const countOf = (day: StatsDay): number => KINDS.reduce((sum, { kind }) => sum + day.stalls[kind], 0);

/** Times the server stopped answering each day, stacked by why. */
export function StallsPerDay({ days }: { days: StatsDay[] }): ReactElement {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const axis = ticks(Math.max(...days.map(countOf), 1), { whole: true });
  const top = axis[axis.length - 1];
  const y = (value: number): number => PAD.top + plotHeight - (value / top) * plotHeight;
  const band = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(28, band * 0.68));
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 64))));
  const hovered = hover === null ? null : days[hover];
  const count = days.reduce((sum, day) => sum + countOf(day), 0);
  const minutes = Math.round(days.reduce((sum, day) => sum + day.stalledMs, 0) / 60_000);
  const totalOf = (kind: ServerStallKind): number => days.reduce((sum, day) => sum + day.stalls[kind], 0);

  return (
    <ChartCard
      title="Server stalls per day"
      headline={`${count} ${count === 1 ? 'stall' : 'stalls'} · ${minutes} min`}
      note="by the day they started · the server did not answer"
      legend={
        <Legend>
          {KINDS.map(({ kind, color }) => (
            <LegendItem key={kind} color={color} label={STALL_KIND_WORDS[kind]} value={String(totalOf(kind))} />
          ))}
        </Legend>
      }
    >
      <Box ref={ref} sx={{ position: 'relative' }} onPointerLeave={() => setHover(null)}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Server stalls per day, ${count} in all`}
          style={{ display: 'block' }}
        >
          {axis.map((value) => (
            <g key={value}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} stroke={CHART.grid} />
              <text
                x={PAD.left - 8}
                y={y(value)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fill={CHART.axis}
              >
                {value}
              </text>
            </g>
          ))}
          {days.map((day, index) => {
            const x = PAD.left + index * band + (band - barWidth) / 2;
            const parts = KINDS.map(({ kind, color }) => ({ kind, color, value: day.stalls[kind] })).filter(
              (part) => part.value > 0,
            );
            let base = 0;
            return (
              <g key={day.day} opacity={hover === null || hover === index ? 1 : 0.4}>
                {parts.map((part, at) => {
                  const bottom = y(base);
                  base += part.value;
                  const segmentTop = y(base);
                  const height = Math.max(bottom - segmentTop - (at > 0 ? GAP : 0), 1);
                  return at === parts.length - 1 ? (
                    <path key={part.kind} d={roundedTop(x, segmentTop, barWidth, height, 4)} fill={part.color} />
                  ) : (
                    <rect key={part.kind} x={x} y={segmentTop} width={barWidth} height={height} fill={part.color} />
                  );
                })}
                {index % labelEvery === 0 ? (
                  <text
                    x={PAD.left + index * band + band / 2}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    fontSize={11}
                    fill={CHART.axis}
                  >
                    {dayLabel(day.day)}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke={CHART.axis} strokeOpacity={0.6} />
          {days.map((day, index) => (
            <rect
              key={`hit-${day.day}`}
              x={PAD.left + index * band}
              y={PAD.top}
              width={band}
              height={plotHeight}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${longDayLabel(day.day)}: ${KINDS.map(({ kind }) => `${day.stalls[kind]} ${STALL_KIND_WORDS[kind]}`).join(', ')}`}
              onPointerEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              style={{ outline: 'none' }}
            />
          ))}
        </svg>
        {hovered && hover !== null ? (
          <ChartTip x={PAD.left + hover * band + band / 2} y={PAD.top} width={width} title={longDayLabel(hovered.day)}>
            <TipRow value={`${Math.round(hovered.stalledMs / 1000)} s`} label="stalled" />
            {KINDS.map(({ kind, color }) => (
              <TipRow key={kind} color={color} value={String(hovered.stalls[kind])} label={STALL_KIND_WORDS[kind]} />
            ))}
          </ChartTip>
        ) : null}
      </Box>
    </ChartCard>
  );
}

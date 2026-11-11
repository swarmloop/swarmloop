'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import type { StatsDay, StatsTotals } from '@contract/api';
import { CHART, ChartCard, ChartTip, MONO, TipRow, roundedTop, useWidth } from './chart-parts';
import { dayLabel, hours, longDayLabel, percent, ticks } from './stats-format';

const HEIGHT = 180;
const PAD = { top: 10, right: 8, bottom: 26, left: 44 };

/** One bar per day. A day without a value has no bar. */
function DayBars({
  days,
  label,
  color,
  value,
  axisText,
  tip,
}: {
  days: StatsDay[];
  label: string;
  color: string;
  value: (day: StatsDay) => number | null;
  axisText: (value: number) => string;
  tip: (day: StatsDay) => ReactElement;
}): ReactElement {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const axis = ticks(Math.max(...days.map((day) => value(day) ?? 0), 1));
  const top = axis[axis.length - 1];
  const y = (at: number): number => PAD.top + plotHeight - (at / top) * plotHeight;
  const band = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(28, band * 0.68));
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 64))));
  const hovered = hover === null ? null : days[hover];
  return (
    <Box ref={ref} sx={{ position: 'relative' }} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={HEIGHT} role="img" aria-label={label} style={{ display: 'block' }}>
        {axis.map((at) => (
          <g key={at}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(at)} y2={y(at)} stroke={CHART.grid} />
            <text
              x={PAD.left - 8}
              y={y(at)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fontFamily={MONO}
              fill={CHART.axis}
            >
              {axisText(at)}
            </text>
          </g>
        ))}
        {days.map((day, index) => {
          const at = value(day);
          const x = PAD.left + index * band + (band - barWidth) / 2;
          return (
            <g key={day.day} opacity={hover === null || hover === index ? 1 : 0.4}>
              {at !== null && at > 0 ? (
                <path d={roundedTop(x, y(at), barWidth, Math.max(y(0) - y(at), 1), 4)} fill={color} />
              ) : null}
              {index % labelEvery === 0 ? (
                <text
                  x={PAD.left + index * band + band / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  fontSize={11}
                  fontFamily={MONO}
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
            data-testid={`${label}-${day.day}`}
            x={PAD.left + index * band}
            y={PAD.top}
            width={band}
            height={plotHeight}
            fill="transparent"
            onPointerEnter={() => setHover(index)}
          />
        ))}
      </svg>
      {hovered && hover !== null ? (
        <ChartTip x={PAD.left + hover * band + band / 2} y={PAD.top} width={width} title={longDayLabel(hovered.day)}>
          {tip(hovered)}
        </ChartTip>
      ) : null}
    </Box>
  );
}

/** Of the runs that finished each day, the share that reached the default branch. Closed runs are counted apart. */
export function MergeShare({ days, totals }: { days: StatsDay[]; totals: StatsTotals }): ReactElement {
  const finished = (day: Pick<StatsDay, 'done' | 'failed'>): number => day.done + day.failed;
  return (
    <ChartCard
      title="Merge share per day"
      headline={percent(totals.merged, finished(totals))}
      note={`${totals.merged} merged · ${totals.closed} closed without a merge · of ${finished(totals)} finished runs`}
    >
      <DayBars
        days={days}
        label="Merge share per day"
        color={CHART.done}
        value={(day) => (finished(day) > 0 ? (day.merged / finished(day)) * 100 : null)}
        axisText={(value) => `${value}%`}
        tip={(day) => (
          <>
            <TipRow color={CHART.done} value={String(day.merged)} label="merged" />
            <TipRow value={String(day.closed)} label="closed" />
            <TipRow value={percent(day.merged, finished(day))} label="of finished runs" />
          </>
        )}
      />
    </ChartCard>
  );
}

/** The median time from done to merge of the runs started each day. */
export function TimeToMerge({ days, totals }: { days: StatsDay[]; totals: StatsTotals }): ReactElement {
  return (
    <ChartCard
      title="Time to merge per day"
      headline={totals.medianToMergeMs === null ? '—' : hours(totals.medianToMergeMs)}
      note={totals.medianToMergeMs === null ? 'no run has been merged' : 'median from done to merge'}
    >
      <DayBars
        days={days}
        label="Time to merge per day"
        color={CHART.active}
        value={(day) => (day.medianToMergeMs === null ? null : day.medianToMergeMs / 3_600_000)}
        axisText={(value) => `${value} h`}
        tip={(day) => (
          <TipRow
            color={CHART.active}
            value={day.medianToMergeMs === null ? '—' : hours(day.medianToMergeMs)}
            label="median to merge"
          />
        )}
      />
    </ChartCard>
  );
}

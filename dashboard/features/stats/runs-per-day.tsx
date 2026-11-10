'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import type { StatsDay } from '@contract/api';
import {
  CHART,
  ChartCard,
  ChartTip,
  Legend,
  LegendItem,
  MONO,
  OUTCOMES,
  TipRow,
  roundedTop,
  useWidth,
} from './chart-parts';
import { dayLabel, longDayLabel, ticks } from './stats-format';

const HEIGHT = 220;
const PAD = { top: 10, right: 8, bottom: 26, left: 34 };
const GAP = 2;

/** Runs started each day, stacked by how they ended. */
export function RunsPerDay({
  days,
  total,
  selected,
  onSelect,
}: {
  days: StatsDay[];
  total: Record<'done' | 'active' | 'failed', number>;
  /** The day whose runs the table shows, or null for all. */
  selected: string | null;
  /** Picks a day, or clears it when that day is picked again. */
  onSelect: (day: string | null) => void;
}): ReactElement {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const max = Math.max(...days.map((day) => day.done + day.active + day.failed), 1);
  const axis = ticks(max, { whole: true });
  const top = axis[axis.length - 1];
  const y = (value: number): number => PAD.top + plotHeight - (value / top) * plotHeight;
  const band = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(28, band * 0.68));
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 64))));
  const hovered = hover === null ? null : days[hover];
  /** The hovered bar stands out; without one, the picked day does. */
  const emphasis = (index: number, day: string): boolean =>
    hover !== null ? hover === index : selected === null || selected === day;
  const runs = total.done + total.active + total.failed;

  return (
    <ChartCard
      title="Runs per day"
      headline={`${runs} ${runs === 1 ? 'run' : 'runs'}`}
      note="by the day they started · click a day to see its runs"
      legend={
        <Legend>
          {OUTCOMES.map(({ outcome, label }) => (
            <LegendItem key={outcome} color={CHART[outcome]} label={label} value={String(total[outcome])} />
          ))}
        </Legend>
      }
    >
      <Box ref={ref} sx={{ position: 'relative' }} onPointerLeave={() => setHover(null)}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Runs per day, ${runs} in all`}
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
                fontFamily={MONO}
                fill={CHART.axis}
              >
                {value}
              </text>
            </g>
          ))}
          {days.map((day, index) => {
            const x = PAD.left + index * band + (band - barWidth) / 2;
            const parts = OUTCOMES.map(({ outcome }) => ({ outcome, value: day[outcome] })).filter(
              (part) => part.value > 0,
            );
            let base = 0;
            return (
              <g key={day.day} opacity={emphasis(index, day.day) ? 1 : 0.4}>
                {parts.map((part, at) => {
                  const bottom = y(base);
                  base += part.value;
                  const segmentTop = y(base);
                  const last = at === parts.length - 1;
                  const height = Math.max(bottom - segmentTop - (at > 0 ? GAP : 0), 1);
                  return last ? (
                    <path
                      key={part.outcome}
                      d={roundedTop(x, segmentTop, barWidth, height, 4)}
                      fill={CHART[part.outcome]}
                    />
                  ) : (
                    <rect
                      key={part.outcome}
                      x={x}
                      y={segmentTop}
                      width={barWidth}
                      height={height}
                      fill={CHART[part.outcome]}
                    />
                  );
                })}
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
              data-testid={`day-${day.day}`}
              x={PAD.left + index * band}
              y={PAD.top}
              width={band}
              height={plotHeight}
              fill="transparent"
              tabIndex={0}
              role="button"
              aria-pressed={selected === day.day}
              aria-label={`${longDayLabel(day.day)}: ${day.done} done, ${day.active} in progress, ${day.failed} failed`}
              onPointerEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(selected === day.day ? null : day.day)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(selected === day.day ? null : day.day);
                }
              }}
              style={{ outline: 'none', cursor: 'pointer' }}
            />
          ))}
        </svg>
        {hovered && hover !== null ? (
          <ChartTip x={PAD.left + hover * band + band / 2} y={PAD.top} width={width} title={longDayLabel(hovered.day)}>
            <TipRow value={String(hovered.done + hovered.active + hovered.failed)} label="started" />
            {OUTCOMES.map(({ outcome, label }) => (
              <TipRow
                key={outcome}
                color={CHART[outcome]}
                value={String(hovered[outcome])}
                label={label.toLowerCase()}
              />
            ))}
          </ChartTip>
        ) : null}
      </Box>
    </ChartCard>
  );
}

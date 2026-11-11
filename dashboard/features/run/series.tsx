'use client';

import { useTheme } from '@mui/material/styles';
import { memory } from '../../lib/format';

interface Point {
  at?: string;
  cpu: number;
  memory: number;
}

/** One line of the chart: a source of samples and its points in time order. */
export interface SeriesLine {
  label: string;
  samples: Point[];
}

const COLORS = ['#2f5d73', '#8a5a2a', '#5a7a3a', '#7a3a6a', '#3a6a7a', '#7a5a3a'];

/** CPU and memory over time. With `lines` each line has its own colour and the x axis is time; else one line by sample. */
export function SeriesChart({ samples, lines }: { samples: Point[]; lines?: SeriesLine[] }): React.ReactElement {
  const theme = useTheme();
  const width = 640;
  const height = 160;
  const left = 44;
  const right = 78;
  const top = 12;
  const bottom = 12;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const drawn: SeriesLine[] = lines ?? [{ label: '', samples }];
  const everyPoint = drawn.flatMap((line) => line.samples);
  const maxMemory = Math.max(...everyPoint.map((sample) => sample.memory), 1);
  const times = lines ? everyPoint.map((sample) => Date.parse(sample.at ?? '')) : [];
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  const x = (index: number, count: number, sample: Point): number =>
    left +
    (lines && span > 0
      ? ((Date.parse(sample.at ?? '') - first) * plotWidth) / span
      : (index * plotWidth) / Math.max(count - 1, 1));
  const yCpu = (value: number): number => top + (1 - Math.min(value, 100) / 100) * plotHeight;
  const yMem = (value: number): number => top + (1 - value / maxMemory) * plotHeight;
  const points = (line: SeriesLine, y: (value: number) => number, pick: (sample: Point) => number): string =>
    line.samples.map((sample, index) => `${x(index, line.samples.length, sample)},${y(pick(sample))}`).join(' ');
  const mark = samples.length === 1 ? samples[0] : null;
  const last = samples.at(-1);
  const font = 'var(--font-mono), ui-monospace, monospace';
  const legend = theme.vars?.palette.text.secondary ?? theme.palette.text.secondary;
  const grid = theme.vars?.palette.divider ?? theme.palette.divider;
  const cpuAxis = theme.vars?.palette.info.main ?? theme.palette.info.main;
  const memoryAxis = theme.vars?.palette.secondary.main ?? theme.palette.secondary.main;
  const color = (index: number): string => COLORS[index % COLORS.length];
  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 6,
          fontFamily: font,
          fontSize: 12,
          color: legend,
        }}
      >
        {lines ? (
          drawn.map((line, index) => (
            <span key={line.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 18, height: 3, background: color(index), display: 'inline-block' }} />
              {line.label}
              {line.samples.length > 0
                ? ` ${line.samples.at(-1)?.cpu.toFixed(0)}% · ${memory(line.samples.at(-1)?.memory ?? 0)}`
                : ''}
            </span>
          ))
        ) : (
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 18, height: 3, background: '#2f5d73', display: 'inline-block' }} />
              CPU{last ? ` ${last.cpu.toFixed(0)}%` : ''}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 18, height: 0, borderTop: '3px dashed #8a5a2a', display: 'inline-block' }} />
              memory{last ? ` ${memory(last.memory)}` : ''}
            </span>
          </>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="CPU and memory"
        style={{ width: '100%', height: 180 }}
      >
        {[0, 0.5, 1].map((row) => {
          const y = top + row * plotHeight;
          return (
            <g key={row}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke={grid} />
              <text
                x={left - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                fill={cpuAxis}
                fontSize="11"
                fontFamily={font}
              >
                {`${Math.round((1 - row) * 100)}%`}
              </text>
              <text
                x={width - right + 8}
                y={y}
                textAnchor="start"
                dominantBaseline="middle"
                fill={memoryAxis}
                fontSize="11"
                fontFamily={font}
              >
                {memory(maxMemory * (1 - row))}
              </text>
            </g>
          );
        })}
        {lines
          ? drawn.map((line, index) =>
              line.samples.length > 1 ? (
                <g key={line.label}>
                  <polyline
                    fill="none"
                    stroke={color(index)}
                    strokeWidth="2"
                    points={points(line, yCpu, (item) => item.cpu)}
                  />
                  <polyline
                    fill="none"
                    stroke={color(index)}
                    strokeWidth="1.5"
                    strokeDasharray="7 4"
                    points={points(line, yMem, (item) => item.memory)}
                  />
                </g>
              ) : (
                line.samples.map((sample, point) => (
                  <circle
                    key={`${line.label}-${point}`}
                    cx={x(0, 1, sample)}
                    cy={yCpu(sample.cpu)}
                    r="4"
                    fill={color(index)}
                  />
                ))
              ),
            )
          : null}
        {!lines && samples.length > 1 ? (
          <>
            <polyline
              fill="none"
              stroke="#2f5d73"
              strokeWidth="2"
              points={points(drawn[0], yCpu, (item) => item.cpu)}
            />
            <polyline
              fill="none"
              stroke="#8a5a2a"
              strokeWidth="2"
              strokeDasharray="7 4"
              points={points(drawn[0], yMem, (item) => item.memory)}
            />
          </>
        ) : null}
        {!lines && mark ? (
          <>
            <circle cx={x(0, 1, mark)} cy={yCpu(mark.cpu)} r="4" fill="#2f5d73" />
            <circle cx={x(0, 1, mark)} cy={yMem(mark.memory)} r="4" fill="#8a5a2a" />
          </>
        ) : null}
      </svg>
    </div>
  );
}

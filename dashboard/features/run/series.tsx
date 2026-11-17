'use client';

import { useTheme } from '@mui/material/styles';
import { cores, memory } from '../../lib/format';

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

/** The axis label of a CPU value: percent, or cores when the chart shows CPU alone. */
function cpuLabel(percent: number, metric: 'cpu' | 'memory' | undefined): string {
  return metric === 'cpu' ? cores(percent) : `${Math.round(percent)}%`;
}

/** The legend value of a line's last sample for the metric shown. */
function legendValue(sample: Point | undefined, metric: 'cpu' | 'memory' | undefined): string {
  const cpu = sample?.cpu ?? 0;
  const mem = sample?.memory ?? 0;
  if (metric === 'cpu') {
    return `${cores(cpu)} cores`;
  }
  return metric === 'memory' ? memory(mem) : `${cpu.toFixed(0)}% · ${memory(mem)}`;
}

const FONT = 'var(--font-mono), ui-monospace, monospace';

/** The grid lines and the value labels of the axes: one axis for a single metric, else CPU left and memory right. */
function GridRows({
  metric,
  maxCpu,
  maxMemory,
  frame,
}: {
  metric: 'cpu' | 'memory' | undefined;
  maxCpu: number;
  maxMemory: number;
  /** The plot area: its left and right edge, top and height. */
  frame: { left: number; right: number; top: number; height: number };
}): React.ReactElement {
  const theme = useTheme();
  const grid = theme.vars?.palette.divider ?? theme.palette.divider;
  const cpuAxis = theme.vars?.palette.info.main ?? theme.palette.info.main;
  const memoryAxis = theme.vars?.palette.secondary.main ?? theme.palette.secondary.main;
  return (
    <>
      {[0, 0.5, 1].map((row) => {
        const y = frame.top + row * frame.height;
        return (
          <g key={row}>
            <line x1={frame.left} x2={frame.right} y1={y} y2={y} stroke={grid} />
            <text
              x={frame.left - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fill={metric === 'memory' ? memoryAxis : cpuAxis}
              fontSize="11"
              fontFamily={FONT}
            >
              {metric === 'memory' ? memory(maxMemory * (1 - row)) : cpuLabel((1 - row) * maxCpu, metric)}
            </text>
            {metric ? null : (
              <text
                x={frame.right + 8}
                y={y}
                textAnchor="start"
                dominantBaseline="middle"
                fill={memoryAxis}
                fontSize="11"
                fontFamily={FONT}
              >
                {memory(maxMemory * (1 - row))}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

const COLORS = ['#2f5d73', '#8a5a2a', '#5a7a3a', '#7a3a6a', '#3a6a7a', '#7a5a3a'];

/** CPU and memory over time. With `lines` each line has its own colour and the x axis is time; else one line by sample. With `metric` (and `lines`) only that metric is drawn, in cores or memory units, on its own axis. */
export function SeriesChart({
  samples,
  lines,
  metric,
}: {
  samples: Point[];
  lines?: SeriesLine[];
  metric?: 'cpu' | 'memory';
}): React.ReactElement {
  const theme = useTheme();
  const width = 640;
  const height = 160;
  const left = 44;
  const right = metric ? 12 : 78;
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
  const maxCpu = metric === 'cpu' ? Math.max(...everyPoint.map((sample) => sample.cpu), 100) : 100;
  const yCpu = (value: number): number => top + (1 - Math.min(value, maxCpu) / maxCpu) * plotHeight;
  const yMem = (value: number): number => top + (1 - value / maxMemory) * plotHeight;
  const points = (line: SeriesLine, y: (value: number) => number, pick: (sample: Point) => number): string =>
    line.samples.map((sample, index) => `${x(index, line.samples.length, sample)},${y(pick(sample))}`).join(' ');
  const mark = samples.length === 1 ? samples[0] : null;
  const last = samples.at(-1);
  const legend = theme.vars?.palette.text.secondary ?? theme.palette.text.secondary;
  const color = (index: number): string => COLORS[index % COLORS.length];
  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 6,
          fontFamily: FONT,
          fontSize: 12,
          color: legend,
        }}
      >
        {lines ? (
          drawn.map((line, index) => (
            <span key={line.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 18, height: 3, background: color(index), display: 'inline-block' }} />
              {line.label}
              {line.samples.length > 0 ? ` ${legendValue(line.samples.at(-1), metric)}` : ''}
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
        aria-label={metric ? { cpu: 'CPU', memory: 'Memory' }[metric] : 'CPU and memory'}
        style={{ width: '100%', height: 180 }}
      >
        <GridRows
          metric={metric}
          maxCpu={maxCpu}
          maxMemory={maxMemory}
          frame={{ left, right: width - right, top, height: plotHeight }}
        />
        {lines
          ? drawn.map((line, index) =>
              line.samples.length > 1 ? (
                <g key={line.label}>
                  {metric === 'memory' ? null : (
                    <polyline
                      fill="none"
                      stroke={color(index)}
                      strokeWidth="2"
                      points={points(line, yCpu, (item) => item.cpu)}
                    />
                  )}
                  {metric === 'cpu' ? null : (
                    <polyline
                      fill="none"
                      stroke={color(index)}
                      strokeWidth={metric ? 2 : 1.5}
                      strokeDasharray={metric ? undefined : '7 4'}
                      points={points(line, yMem, (item) => item.memory)}
                    />
                  )}
                </g>
              ) : (
                line.samples.map((sample, point) => (
                  <circle
                    key={`${line.label}-${point}`}
                    cx={x(0, 1, sample)}
                    cy={metric === 'memory' ? yMem(sample.memory) : yCpu(sample.cpu)}
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

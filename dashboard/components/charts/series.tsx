'use client';

import { useTheme } from '@mui/material/styles';
import { memory } from '../../lib/format';

export function SeriesChart({ samples }: { samples: { cpu: number; memory: number }[] }) {
  const theme = useTheme();
  const width = 640;
  const height = 160;
  const left = 44;
  const right = 78;
  const top = 12;
  const bottom = 12;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxMemory = Math.max(...samples.map((sample) => sample.memory), 1);
  const x = (index: number): number => left + (index * plotWidth) / Math.max(samples.length - 1, 1);
  const yCpu = (value: number): number => top + (1 - Math.min(value, 100) / 100) * plotHeight;
  const yMem = (value: number): number => top + (1 - value / maxMemory) * plotHeight;
  const cpu = samples.map((sample, index) => `${x(index)},${yCpu(sample.cpu)}`).join(' ');
  const memoryLine = samples.map((sample, index) => `${x(index)},${yMem(sample.memory)}`).join(' ');
  const mark = samples.length === 1 ? samples[0] : null;
  const last = samples.at(-1);
  const font = 'var(--font-mono), ui-monospace, monospace';
  const legend = theme.vars?.palette.text.secondary ?? theme.palette.text.secondary;
  const grid = theme.vars?.palette.divider ?? theme.palette.divider;
  const cpuAxis = theme.vars?.palette.info.main ?? theme.palette.info.main;
  const memoryAxis = theme.vars?.palette.secondary.main ?? theme.palette.secondary.main;
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 6, fontFamily: font, fontSize: 12, color: legend }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 18, height: 3, background: '#2f5d73', display: 'inline-block' }} />
          CPU{last ? ` ${last.cpu.toFixed(0)}%` : ''}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 18, height: 0, borderTop: '3px dashed #8a5a2a', display: 'inline-block' }} />
          memory{last ? ` ${memory(last.memory)}` : ''}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="CPU and memory" style={{ width: '100%', height: 180 }}>
        {[0, 0.5, 1].map((row) => {
          const y = top + row * plotHeight;
          return (
            <g key={row}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke={grid} />
              <text x={left - 8} y={y} textAnchor="end" dominantBaseline="middle" fill={cpuAxis} fontSize="11" fontFamily={font}>
                {`${Math.round((1 - row) * 100)}%`}
              </text>
              <text x={width - right + 8} y={y} textAnchor="start" dominantBaseline="middle" fill={memoryAxis} fontSize="11" fontFamily={font}>
                {memory(maxMemory * (1 - row))}
              </text>
            </g>
          );
        })}
        {samples.length > 1 ? (
          <>
            <polyline fill="none" stroke="#2f5d73" strokeWidth="2" points={cpu} />
            <polyline fill="none" stroke="#8a5a2a" strokeWidth="2" strokeDasharray="7 4" points={memoryLine} />
          </>
        ) : null}
        {mark ? (
          <>
            <circle cx={x(0)} cy={yCpu(mark.cpu)} r="4" fill="#2f5d73" />
            <circle cx={x(0)} cy={yMem(mark.memory)} r="4" fill="#8a5a2a" />
          </>
        ) : null}
      </svg>
    </div>
  );
}

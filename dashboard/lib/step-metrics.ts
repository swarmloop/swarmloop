import { count, duration, memory, money } from './format.ts';

export type StepMetricKind = 'status' | 'duration' | 'attempt' | 'spend' | 'tokens-in' | 'tokens-out' | 'cpu' | 'memory';

export interface StepMetric {
  kind: StepMetricKind;
  text: string;
  tip: string;
}

export function stepMetrics(input: {
  status: string;
  attempt: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  cpuAvg: number;
  cpuPeak: number;
  memAvg: number;
  memPeak: number;
}): StepMetric[] {
  const items: StepMetric[] = [
    { kind: 'status', text: input.status, tip: 'Step status' },
    { kind: 'duration', text: duration(input.durationMs), tip: 'Time this attempt has run' },
  ];
  if (input.attempt > 0) {
    items.push({ kind: 'attempt', text: `attempt ${input.attempt}`, tip: 'Attempt' });
  }
  items.push(
    { kind: 'spend', text: money(input.usd), tip: 'Spend for this attempt' },
    { kind: 'tokens-in', text: `${count(input.tokensIn)} in`, tip: 'Input tokens' },
    { kind: 'tokens-out', text: `${count(input.tokensOut)} out`, tip: 'Output tokens' },
    { kind: 'cpu', text: `cpu ${input.cpuAvg.toFixed(0)}/${input.cpuPeak.toFixed(0)}%`, tip: 'CPU average and peak' },
    { kind: 'memory', text: `mem ${memory(input.memAvg)}/${memory(input.memPeak)}`, tip: 'Memory average and peak' },
  );
  return items;
}

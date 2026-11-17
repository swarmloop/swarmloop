import { count, duration, memory, money } from '../../lib/format';

export type StepMetricKind = 'status' | 'duration' | 'attempt' | 'memory' | 'spend' | 'tokens-in' | 'tokens-out';

interface StepMetric {
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
  /** A server step spends nothing and has no model: it keeps status, time and attempt. */
  server?: boolean;
  /** The peak memory of the attempt in bytes: a server step shows it when it was measured. */
  memPeak?: number;
}): StepMetric[] {
  const items: StepMetric[] = [
    { kind: 'status', text: input.status, tip: 'Step status' },
    { kind: 'duration', text: duration(input.durationMs), tip: 'Time this attempt has run' },
  ];
  if (input.attempt > 0) {
    items.push({ kind: 'attempt', text: `attempt ${input.attempt}`, tip: 'Attempt' });
  }
  if (input.server) {
    if (input.memPeak) {
      items.push({ kind: 'memory', text: memory(input.memPeak), tip: 'Peak memory of this attempt' });
    }
    return items;
  }
  items.push(
    { kind: 'spend', text: money(input.usd), tip: 'Spend for this attempt' },
    { kind: 'tokens-in', text: `${count(input.tokensIn)} in`, tip: 'Input tokens' },
    { kind: 'tokens-out', text: `${count(input.tokensOut)} out`, tip: 'Output tokens' },
  );
  return items;
}

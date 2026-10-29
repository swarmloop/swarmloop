import { HttpCallDraft } from '../swarmloop-error';

export interface SampleDraft {
  sampledAt: string;
  cpuPercent: number;
  rssBytes: number;
}

export function sampleSelf(): SampleDraft {
  return {
    sampledAt: new Date().toISOString(),
    cpuPercent: 0,
    rssBytes: process.memoryUsage().rss,
  };
}

export interface ExchangeDraft {
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  requestText: string;
  responseText: string;
  chatId: string | null;
  resumed: boolean;
  killReason: string | null;
}

export interface DocumentDraft {
  kind: string;
  fileName: string;
  body: string;
}

export interface VisitDraft {
  step: string;
  model: string | null;
  mode: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  exitCode: number | null;
  killReason: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  samples: SampleDraft[];
  exchange: ExchangeDraft | null;
  exchanges?: ExchangeDraft[];
  httpCalls: HttpCallDraft[];
  document: DocumentDraft | null;
  documents?: DocumentDraft[];
  resumed: boolean;
}

export function summarizeSamples(samples: SampleDraft[]): {
  cpuAvg: number;
  cpuPeak: number;
  memAvg: number;
  memPeak: number;
} {
  if (samples.length === 0) {
    return { cpuAvg: 0, cpuPeak: 0, memAvg: 0, memPeak: 0 };
  }
  const cpu = samples.map((sample) => sample.cpuPercent);
  const mem = samples.map((sample) => sample.rssBytes);
  const avg = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    cpuAvg: avg(cpu),
    cpuPeak: Math.max(...cpu),
    memAvg: Math.round(avg(mem)),
    memPeak: Math.max(...mem),
  };
}

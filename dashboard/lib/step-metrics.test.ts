import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stepMetrics } from './step-metrics.ts';

const example = {
  status: 'running',
  attempt: 1,
  durationMs: 67_000,
  tokensIn: 527_210,
  tokensOut: 3_492,
  usd: 1.08,
  cpuAvg: 10,
  cpuPeak: 71,
  memAvg: 416_494_387,
  memPeak: 462_107_443,
};

describe('stepMetrics', () => {
  it('lists status, time, attempt, spend, tokens, cpu, and memory', () => {
    assert.deepEqual(
      stepMetrics(example).map((item) => item.text),
      ['running', '1m 7s', 'attempt 1', '$1.08', '527,210 in', '3,492 out', 'cpu 10/71%', 'mem 397.2 MB/440.7 MB'],
    );
  });

  it('omits a zero attempt and still shows zero figures', () => {
    assert.deepEqual(
      stepMetrics({
        status: 'running',
        attempt: 0,
        durationMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        cpuAvg: 0,
        cpuPeak: 0,
        memAvg: 0,
        memPeak: 0,
      }).map((item) => item.text),
      ['running', '0s', '$0', '0 in', '0 out', 'cpu 0/0%', 'mem 0 KB/0 KB'],
    );
  });
});

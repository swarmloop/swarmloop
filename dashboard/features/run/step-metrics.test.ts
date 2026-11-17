import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { stepMetrics } from './step-metrics.ts';

const example = {
  status: 'running',
  attempt: 1,
  durationMs: 67_000,
  tokensIn: 527_210,
  tokensOut: 3_492,
  usd: 1.08,
};

describe('stepMetrics', () => {
  it('lists status, time, attempt, spend, and tokens', () => {
    assert.deepEqual(
      stepMetrics(example).map((item) => item.text),
      ['running', '1m 7s', 'attempt 1', '$1.08', '527,210 in', '3,492 out'],
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
      }).map((item) => item.text),
      ['running', '0s', '$0', '0 in', '0 out'],
    );
  });

  it('lists status, time, attempt and memory for a server step, and no memory when none was measured', () => {
    const server = { ...example, server: true, tokensIn: 9, tokensOut: 8, usd: 3 };

    assert.deepEqual(
      stepMetrics({ ...server, memPeak: 3 * 1024 * 1024 }).map((item) => item.text),
      ['running', '1m 7s', 'attempt 1', '3 MB'],
    );
    assert.deepEqual(
      stepMetrics({ ...server, memPeak: 0 }).map((item) => item.kind),
      ['status', 'duration', 'attempt'],
    );
  });
});

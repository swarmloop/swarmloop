import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@contract/api';
import type { LiveRunUsage } from '@contract/live';
import { runSummary } from '../../test/fixtures';
import { applyUsage } from './apply-usage';

const row = (key: string, overrides: Partial<RunSummary> = {}): RunSummary => ({ ...runSummary(), key, ...overrides });
const entry = (overrides: Partial<LiveRunUsage> = {}): LiveRunUsage => ({
  key: 'b',
  tokens: 10,
  usd: 2.5,
  cpuPeak: 1,
  memPeak: 2,
  ...overrides,
});

describe('applyUsage', () => {
  it('replaces the cost of the matching row and keeps the other rows as they are', () => {
    const rows = [row('a', { usd: 1 }), row('b', { usd: 1 })];

    const result = applyUsage(rows, entry());

    expect(result.map((item) => item.usd)).toEqual([1, 2.5]);
    expect(result[0]).toBe(rows[0]);
  });

  it('replaces the epic total only when the entry has one', () => {
    const held = { usd: 4, durationMs: 1000 };
    const rows = [row('b', { epic: held })];

    expect(applyUsage(rows, entry())[0]?.epic).toEqual(held);
    expect(applyUsage(rows, entry({ epic: { usd: 9, durationMs: 2000 } }))[0]?.epic).toEqual({
      usd: 9,
      durationMs: 2000,
    });
  });

  it('never adds the cost to what the row held', () => {
    const once = applyUsage([row('b', { usd: 1 })], entry());
    expect(applyUsage(once, entry())[0]?.usd).toBe(2.5);
  });
});

import { describe, expect, it } from 'vitest';
import type { FlowView, TaskEntry } from '@contract/api';
import type { LiveRunUsage } from '@contract/live';
import { flowView } from '../../test/fixtures';
import { withUsage } from './flow-usage';

const entry = (key: string, overrides: Partial<LiveRunUsage> = {}): LiveRunUsage => ({
  key,
  tokens: 70,
  usd: 3,
  cpuPeak: 11,
  memPeak: 22,
  ...overrides,
});
const task = (id: string, runKey: string): TaskEntry => ({
  id,
  index: 0,
  title: id,
  files: [],
  proof: '',
  depends: [],
  status: 'running',
  run: { key: runKey, state: 'running', currentStep: 'implement', usd: 1, durationMs: 0 },
});
const epicFlow = (): FlowView => flowView({ tasks: [task('a', 'run-1-a'), task('b', 'run-1-b')] });

describe('withUsage', () => {
  it('replaces the tokens, cost and peaks of its own run, and nothing else of the metrics', () => {
    const flow = flowView();

    const result = withUsage(flow, entry('run-1'));

    expect(result.metrics).toEqual({ ...flow.metrics, tokens: 70, usd: 3, cpuPeak: 11, memPeak: 22 });
    expect(result.epic).toBeUndefined();
  });

  it('replaces the epic total when the entry has one', () => {
    const result = withUsage(epicFlow(), entry('run-1', { epic: { usd: 8, durationMs: 5000 } }));

    expect(result.epic).toEqual({ usd: 8, durationMs: 5000 });
  });

  it('replaces the cost of the task whose run the entry is for', () => {
    const result = withUsage(epicFlow(), entry('run-1-b'));

    expect(result.tasks?.map((item) => item.run?.usd)).toEqual([1, 3]);
    expect(result.metrics).toEqual(epicFlow().metrics);
  });

  it('returns the page as it is for another run', () => {
    const flow = epicFlow();
    expect(withUsage(flow, entry('other'))).toBe(flow);
  });
});

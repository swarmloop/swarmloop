import type { FlowView, HistoryView, RunSummary, StatsView, StepView } from '@contract/api';
import { actionsFor } from '@contract/run-state';
import type { RunState } from '@contract/run-state';
import { visitKey } from '@contract/visit-key';

const at = '2026-01-01T00:00:00.000Z';

export function runSummary(): RunSummary {
  return {
    key: 'run-1',
    name: 'Run one',
    status: 'running',
    currentStep: 'implement',
    createdAt: at,
    updatedAt: at,
    stepStartedAt: null,
    durationMs: 0,
    usd: 0,
  };
}

/** The state the server derives for a status. A waiting run with open items waits for a person. */
function stateOf(status: string, open: boolean): RunState {
  if (status === 'waiting') return open ? 'waiting' : 'idle';
  return (['running', 'failed', 'done', 'blocked'] as const).find((state) => state === status) ?? 'idle';
}

export function flowView(overrides: Partial<FlowView> = {}): FlowView {
  const state = overrides.state ?? stateOf(overrides.status ?? 'running', (overrides.items ?? []).length > 0);
  return {
    key: 'run-1',
    name: 'Run one',
    status: 'running',
    currentStep: 'implement',
    updatedAt: at,
    stepStartedAt: null,
    resume: 'running',
    state,
    stateReason: null,
    actions: actionsFor(state, overrides.stateReason?.code),
    revision: 0,
    sentence: 'Run one is running.',
    metrics: {
      status: 'running',
      durationMs: 0,
      closedStarts: [],
      tokens: 0,
      usd: 0,
      attemptsReview: 0,
      attemptsQa: 0,
      attemptsPipeline: 0,
      cpuPeak: 0,
      memPeak: 0,
    },
    phases: [
      { phase: 'implementation', steps: [{ name: 'implement', status: 'running', current: true, attempts: 0 }] },
    ],
    returns: [],
    items: [],
    paths: [],
    reason: null,
    launches: [],
    projects: [],
    workspace: null,
    ...overrides,
  };
}

export function visitView(overrides: Partial<StepView['visits'][number]> = {}): StepView['visits'][number] {
  return {
    id: 1,
    attempt: 1,
    status: 'done',
    model: 'claude-opus',
    mode: 'agent',
    durationMs: 1000,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    cpuAvg: 0,
    cpuPeak: 0,
    memAvg: 0,
    memPeak: 0,
    killReason: null,
    decision: null,
    documents: [],
    exchanges: [],
    samples: [],
    ...overrides,
    key: overrides.key ?? visitKey(overrides.id ?? 1),
  };
}

export function stepView(overrides: Partial<StepView> = {}): StepView {
  return {
    step: 'implement',
    visits: [visitView()],
    checks: [],
    descriptor: { name: 'implement', kind: 'agent' },
    eventsCursor: 0,
    ...overrides,
  };
}

export function historyView(overrides: Partial<HistoryView> = {}): HistoryView {
  return {
    launches: [],
    documents: [],
    files: [],
    exchanges: [],
    loops: [],
    calls: [],
    samples: [],
    stats: [],
    ...overrides,
  };
}

export function statsView(overrides: Partial<StatsView> = {}): StatsView {
  const day = (date: string, values: Partial<StatsView['days'][number]> = {}) => ({
    day: date,
    done: 0,
    active: 0,
    failed: 0,
    usd: 0,
    returns: 0,
    ...values,
  });
  return {
    from: '2026-11-08',
    to: '2026-11-10',
    totals: {
      runs: 4,
      done: 2,
      active: 1,
      failed: 1,
      usd: 4.25,
      tokensIn: 4500,
      tokensOut: 400,
      reviewReturns: 2,
      pipelineReturns: 1,
      firstPass: 1,
      limits: 2,
      agentMs: 300_000,
      medianDoneMs: 2_100_000,
    },
    days: [
      day('2026-11-08', { done: 1, usd: 3, returns: 2 }),
      day('2026-11-09'),
      day('2026-11-10', { done: 1, active: 1, failed: 1, usd: 1.25, returns: 1 }),
    ],
    steps: [
      { name: 'implement', usd: 2.75, tokens: 2700, count: 3 },
      { name: 'plan', usd: 1, tokens: 1100, count: 1 },
    ],
    models: [{ name: 'model-a', usd: 3.75, tokens: 3300, count: 3 }],
    agents: [{ name: 'claude', usd: 4, tokens: 3300, count: 2 }],
    reasons: [
      { name: 'quality', returns: 2 },
      { name: 'pipeline', returns: 1 },
    ],
    returnsPerRun: [
      { returns: '0', runs: 2 },
      { returns: '1', runs: 1 },
      { returns: '2', runs: 1 },
      { returns: '3', runs: 0 },
      { returns: '4+', runs: 0 },
    ],
    runs: [
      {
        key: 'run-d',
        name: 'One pass',
        status: 'done',
        outcome: 'done',
        usd: 0.25,
        returns: 0,
        durationMs: 600_000,
        createdAt: '2026-11-10T09:00:00.000Z',
      },
      {
        key: 'run-c',
        name: 'Fix the bug',
        status: 'waiting',
        outcome: 'active',
        usd: 1,
        returns: 1,
        durationMs: 0,
        createdAt: '2026-11-10T08:00:00.000Z',
      },
      {
        key: 'run-a',
        name: 'Add a stats page',
        status: 'done',
        outcome: 'done',
        usd: 3,
        returns: 2,
        durationMs: 3_600_000,
        createdAt: '2026-11-08T10:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

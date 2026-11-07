import type { FlowView, HistoryView, RunSummary, StepView } from '@contract/api';
import { actionsFor } from '@contract/run-state';
import type { RunState } from '@contract/run-state';

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

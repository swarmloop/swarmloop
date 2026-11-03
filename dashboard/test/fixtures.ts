import type { FlowView, HistoryView, RunSummary, StepView } from '@contract/api';

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

export function flowView(overrides: Partial<FlowView> = {}): FlowView {
  return {
    key: 'run-1',
    name: 'Run one',
    status: 'running',
    currentStep: 'implement',
    updatedAt: at,
    stepStartedAt: null,
    resume: 'running',
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
    phases: [{ phase: 'implementation', steps: [{ name: 'implement', status: 'running', current: true, attempts: 0 }] }],
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

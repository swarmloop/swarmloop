import type { ConnectionCard, SignInView } from '@contract/connections';
import type { FlowView, HistoryView, RunSummary, StatsView, StepView } from '@contract/api';
import { actionsFor } from '@contract/run-state';
import type { RunState } from '@contract/run-state';
import { visitKey } from '@contract/visit-key';

const at = '2026-01-01T00:00:00.000Z';

export function runSummary(): RunSummary {
  return {
    key: 'run-1',
    name: 'Run one',
    title: 'Run one',
    status: 'running',
    currentStep: 'implement',
    createdAt: at,
    updatedAt: at,
    stepStartedAt: null,
    durationMs: 0,
    usd: 0,
    state: 'running',
    stateReason: null,
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
    title: 'Run one',
    mergeRequests: [],
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
      attemptsPipeline: 0,
      attemptsChecks: 0,
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
    attemptId: null,
    logBytes: 0,
    logLines: 0,
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
    epics: { done: 0, active: 0, failed: 0 },
    tasks: { done: 0, active: 0, failed: 0 },
    usd: 0,
    returns: 0,
    merged: 0,
    closed: 0,
    medianToMergeMs: null,
    stalls: { 'server-blocked': 0, 'host-paused': 0 },
    stalledMs: 0,
    ...values,
  });
  return {
    from: '2026-11-08',
    to: '2026-11-10',
    epics: { finished: 1, active: 0, failed: 0, medianUsd: 3, medianMs: 3_600_000, back: 1, medianReturns: 2 },
    tasks: { finished: 2, active: 1, failed: 1, medianUsd: 2.13, medianMs: 2_100_000, back: 1, medianReturns: 1 },
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
      returnsByKind: [
        { kind: 'review', returns: 2 },
        { kind: 'pipeline', returns: 1 },
      ],
      firstPass: 1,
      limits: 2,
      agentMs: 300_000,
      medianDoneMs: 2_100_000,
      merged: 1,
      closed: 1,
      medianToMergeMs: 7_200_000,
      requirementsMet: 0,
      requirementsTotal: 0,
      caughtAndFixed: 0,
      personMessages: 0,
    },
    days: [
      day('2026-11-08', {
        done: 1,
        epics: { done: 1, active: 0, failed: 0 },
        usd: 3,
        returns: 2,
        merged: 1,
        medianToMergeMs: 7_200_000,
      }),
      day('2026-11-09', {
        tasks: { done: 1, active: 0, failed: 0 },
        stalls: { 'server-blocked': 2, 'host-paused': 1 },
        stalledMs: 150_000,
      }),
      day('2026-11-10', {
        done: 1,
        active: 1,
        failed: 1,
        tasks: { done: 1, active: 1, failed: 1 },
        usd: 1.25,
        returns: 1,
        closed: 1,
      }),
    ],
    steps: [
      { name: 'implement', usd: 2.75, tokens: 2700, count: 3 },
      { name: 'plan', usd: 1, tokens: 1100, count: 1 },
    ],
    models: [{ name: 'model-a', usd: 3.75, tokens: 3300, count: 3 }],
    efforts: [{ name: 'runtime default', usd: 3.75, tokens: 3300, count: 3 }],
    agents: [{ name: 'claude', usd: 4, tokens: 3300, count: 2 }],
    reasons: [
      { name: 'quality', returns: 2 },
      { name: 'pipeline', returns: 1 },
    ],
    ciReturns: { only: 0, withChecks: 1, jobs: [] },
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
        title: 'One pass',
        status: 'done',
        outcome: 'done',
        kind: 'task',
        usd: 0.25,
        returns: 0,
        shellEdits: 0,
        durationMs: 600_000,
        createdAt: '2026-11-10T09:00:00.000Z',
      },
      {
        key: 'run-c',
        name: 'Fix the bug',
        title: 'Fix the bug',
        status: 'waiting',
        outcome: 'active',
        kind: 'task',
        usd: 1,
        returns: 1,
        shellEdits: 0,
        durationMs: 0,
        createdAt: '2026-11-10T08:00:00.000Z',
      },
      {
        key: 'run-a',
        name: 'Add a stats page',
        title: 'Add a stats page',
        status: 'done',
        outcome: 'done',
        kind: 'epic',
        usd: 3,
        returns: 2,
        shellEdits: 7,
        durationMs: 3_600_000,
        createdAt: '2026-11-08T10:00:00.000Z',
      },
    ],
    subtasks: [
      {
        key: 'run-f',
        name: 'A subtask that failed',
        title: 'A subtask that failed',
        status: 'failed',
        outcome: 'failed',
        kind: 'task',
        usd: 0.5,
        returns: 0,
        shellEdits: 0,
        durationMs: 120_000,
        createdAt: '2026-11-10T10:00:00.000Z',
      },
      {
        key: 'run-g',
        name: 'A subtask that is done',
        title: 'A subtask that is done',
        status: 'done',
        outcome: 'done',
        kind: 'task',
        usd: 0.5,
        returns: 0,
        shellEdits: 0,
        durationMs: 120_000,
        createdAt: '2026-11-09T10:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

export function connectionCard(overrides: Partial<ConnectionCard> = {}): ConnectionCard {
  return {
    id: 'claude',
    logo: 'claude',
    label: 'Claude',
    purpose: 'Runs coding agents',
    status: 'not-connected',
    account: null,
    last4: null,
    reason: null,
    serverDefault: false,
    flows: [
      { kind: 'cli-code', label: 'Sign in with Claude', fields: [], helpUrl: null },
      {
        kind: 'secret',
        label: 'Paste an API key',
        fields: [{ name: 'apiKey', label: 'API key', secret: true }],
        helpUrl: null,
      },
    ],
    ...overrides,
  };
}

export function signInView(overrides: Partial<SignInView> = {}): SignInView {
  return { id: 'session-1', state: 'waiting', link: null, code: null, message: null, ...overrides };
}

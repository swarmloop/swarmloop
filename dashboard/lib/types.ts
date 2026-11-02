export interface RunSummary {
  key: string;
  name: string;
  status: string;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
  stepStartedAt: string | null;
  durationMs: number;
  usd: number;
}

export interface FlowItem {
  kind: 'question' | 'paste';
  id: string;
  label: string;
  answer: string;
}

export interface FlowView {
  key: string;
  name: string;
  status: string;
  currentStep: string;
  updatedAt: string;
  stepStartedAt: string | null;
  resume: 'ready' | 'need-answers' | 'running' | 'blocked' | 'done';
  sentence: string;
  metrics: {
    status: string;
    durationMs: number;
    closedStarts: string[];
    tokens: number;
    usd: number;
    attemptsReview: number;
    attemptsQa: number;
    attemptsPipeline: number;
    cpuPeak: number;
    memPeak: number;
  };
  phases: { phase: string; steps: { name: string; status: string; current: boolean; attempts: number }[] }[];
  returns: { counter: string; count: number; from: string; to: string }[];
  items: FlowItem[];
  paths: { repo: string; path: string }[];
  reason: string | null;
  launches: { phases: string[]; fromStep: string | null; createdAt: string }[];
  projects: string[];
}

export interface VisitView {
  id: number;
  attempt: number;
  status: string;
  model: string | null;
  mode: string | null;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  cpuAvg: number;
  cpuPeak: number;
  memAvg: number;
  memPeak: number;
  killReason: string | null;
  decision: string | null;
  documents: { kind: string; attempt: number; body: string; createdAt: string }[];
  exchanges: { model: string; durationMs: number; request: string; response: string }[];
  samples: { at: string; cpu: number; memory: number }[];
}

export interface StepView {
  step: string;
  visits: VisitView[];
  checks: { name: string; decision: string | null; body: string }[];
}

export interface HistoryView {
  launches: { phases: string[]; fromStep: string | null; createdAt: string }[];
  documents: { kind: string; attempt: number; body: string; createdAt: string }[];
  files: { name: string; path: string; body: string | null }[];
  exchanges: { stepStatId: number; model: string; durationMs: number; request: string; response: string }[];
  loops: { counter: string; attempt: number; reason: string; createdAt: string }[];
  calls: { method: string; url: string; statusCode: number | null; durationMs: number; error: string | null }[];
  samples: { stepStatId: number; at: string; cpu: number; memory: number }[];
  stats: {
    id: number;
    step: string;
    attempt: number;
    model: string | null;
    durationMs: number;
    usd: number;
    tokensIn: number;
    tokensOut: number;
    cpuPeak: number;
    memPeak: number;
  }[];
}

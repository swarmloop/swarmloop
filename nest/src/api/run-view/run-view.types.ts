import { REVIEW_STEPS, StepName } from '../../pipeline/pipeline-result';

export const PHASES: { phase: string; steps: string[] }[] = [
  { phase: 'requirements', steps: ['requirements'] },
  { phase: 'planning', steps: ['prepare', 'research', 'plan', 'plan-improve'] },
  { phase: 'implementation', steps: ['branch', 'implement', 'implement-improve'] },
  { phase: 'code review', steps: REVIEW_STEPS },
  { phase: 'ci', steps: ['commit', 'merge-request', 'pipeline', 'done'] },
];

export const REVIEW_KINDS = [
  'review_requirements',
  'review_quality',
  'review_regressions',
  'review_security',
  'review_performance',
] as const;

export const STEP_KINDS: Partial<Record<StepName, string[]>> = {
  requirements: ['requirements', 'pending'],
  research: ['repos', 'questions', 'answers'],
  plan: ['requirements'],
  'plan-improve': ['requirements'],
  implement: ['implementation'],
  'implement-improve': ['implementation'],
  'code-review': [...REVIEW_KINDS, 'review_residual', 'review_report'],
  commit: ['commit'],
  'merge-request': ['merge_request'],
  pipeline: ['pipeline_log'],
};

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
  returns: { counter: string; count: number; from: string; to: 'implement' }[];
  items: FlowItem[];
  paths: { repo: string; path: string }[];
  reason: string | null;
  launches: LaunchView[];
  projects: string[];
}

export interface LaunchView {
  phases: string[];
  fromStep: string | null;
  createdAt: string;
}

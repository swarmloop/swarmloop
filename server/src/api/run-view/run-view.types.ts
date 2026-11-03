import { REVIEW_STEPS, StepName } from '../../contract/steps';

export const PHASES: { phase: string; steps: readonly string[] }[] = [
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

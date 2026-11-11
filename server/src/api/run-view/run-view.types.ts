import type { StepName } from '../../contract/steps';
import { PHASE_STEPS, PHASES as CONTRACT_PHASES, REVIEW_STEPS } from '../../contract/steps';

/** The phases of the flow board: the contract's phases, with the reviewers as the steps of code review. */
export const PHASES: { phase: string; steps: readonly string[] }[] = CONTRACT_PHASES.map((phase) => ({
  phase,
  steps: phase === 'code-review' ? REVIEW_STEPS : PHASE_STEPS[phase],
}));

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
  implement: ['implementation', 'checks'],
  'implement-improve': ['implementation', 'checks'],
  checks: ['checks'],
  'code-review': [...REVIEW_KINDS, 'review_residual', 'review_report'],
  commit: ['commit'],
  'merge-request': ['merge_request'],
  pipeline: ['pipeline_log'],
};

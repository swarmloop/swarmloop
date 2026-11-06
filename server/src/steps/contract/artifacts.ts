import { CODE_REVIEWERS, STEPS, type StepName } from '../../contract/steps';
import { REBASE_CONFLICT } from '../../git/rebase';
import type { Issue } from './step-contract';
import { artifact, artifactFamily, jsonArrayCodec, linesCodec, type Artifact, type ArtifactFamily } from './artifact';

const WORK_STEPS: readonly StepName[] = STEPS.filter((step) => step !== 'done');
const AGENT_STEPS: readonly StepName[] = ['research', 'plan', 'plan-improve', 'implement', 'implement-improve'];

/** Every kind a step reads or writes. */
export const ARTIFACTS = {
  requirements: artifact('requirements', {
    writers: ['requirements', 'plan', 'plan-improve', 'implement', 'implement-improve'],
    readers: [
      'requirements',
      'prepare',
      'research',
      'plan',
      'plan-improve',
      'branch',
      'implement',
      'implement-improve',
      'code-review',
      'commit',
      'merge-request',
      'pipeline',
    ],
  }),
  repos: artifact('repos', {
    writers: ['research', 'prepare', 'code-review'],
    readers: [
      'prepare',
      'research',
      'plan',
      'plan-improve',
      'branch',
      'implement',
      'implement-improve',
      'code-review',
      'commit',
      'merge-request',
      'pipeline',
    ],
    codec: linesCodec,
  }),
  addedRepos: artifact('added_repos', {
    writers: ['prepare'],
    readers: ['prepare', 'plan', 'plan-improve', 'implement', 'implement-improve'],
  }),
  pendingRepos: artifact('pending_repos', { writers: ['prepare'], readers: ['prepare'] }),
  handoff: artifact('handoff', { writers: [], readers: WORK_STEPS, external: true }),
  return: artifact('return', { writers: ['code-review', 'pipeline'], readers: ['implement', 'implement-improve'] }),
  issues: artifact('issues', {
    writers: ['code-review', 'pipeline'],
    readers: ['implement', 'implement-improve'],
    codec: jsonArrayCodec<Issue>(),
  }),
  implementation: artifact('implementation', {
    writers: ['implement', 'implement-improve'],
    readers: ['implement', 'implement-improve', 'code-review', 'merge-request'],
  }),
  answers: artifact('answers', { writers: [], readers: ['research', 'plan'], external: true }),
  questions: artifact('questions', { writers: ['research'], readers: ['plan'] }),
  pipelineRef: artifact('pipeline_ref', {
    writers: ['commit', 'implement'],
    readers: ['branch', 'implement', 'pipeline'],
  }),
  pipelineLog: artifact('pipeline_log', {
    writers: ['pipeline'],
    readers: ['pipeline', 'implement', 'implement-improve'],
  }),
  pipelineRebases: artifact('pipeline_rebases', { writers: ['pipeline'], readers: ['pipeline'] }),
  ciSkip: artifact('ci_skip', { writers: ['commit'], readers: ['commit', 'merge-request', 'pipeline'] }),
  ciRerun: artifact('ci_rerun', { writers: ['implement'], readers: ['commit'] }),
  rebaseConflict: artifact(REBASE_CONFLICT, {
    writers: ['implement', 'code-review'],
    readers: ['implement', 'code-review'],
  }),
  rebaseMergeSkip: artifact('rebase_merge_skip', {
    writers: ['implement', 'merge-request'],
    readers: ['merge-request'],
  }),
  commit: artifact('commit', { writers: ['commit'], readers: ['commit'] }),
  mergeRequest: artifact('merge_request', { writers: ['merge-request'], readers: [] }),
  reviewReport: artifact('review_report', { writers: ['code-review'], readers: ['merge-request'] }),
  requirementsProgress: artifact('requirements_progress', { writers: ['requirements'], readers: ['requirements'] }),
  pending: artifact('pending', { writers: ['requirements'], readers: [] }),
  error: artifact('error', { writers: [], readers: [], external: true }),
  log: artifact('log', { writers: [], readers: [], external: true }),
} as const satisfies Record<string, Artifact<unknown>>;

/** `instructions:<step>`, written when a person gives a step new instructions. */
export const INSTRUCTIONS: ArtifactFamily = artifactFamily('instructions:', AGENT_STEPS);

/** `review_<reviewer>`, written by the code-review step. */
export const REVIEWS: ArtifactFamily = artifactFamily('review_', CODE_REVIEWERS);

/** Kinds owned outside `steps`, each with the module that owns it. */
export const SERVICE_KINDS: Readonly<Record<string, string>> = {
  chat_lock: 'pipeline/chat-lock',
  shell_resume: 'pipeline/worktree-snapshot',
  snapshot: 'pipeline/worktree-snapshot',
  environment: 'environment/project-environments',
  checks_pass: 'environment/project-environments',
  loop_mark: 'pipeline/run-driver',
  spend: 'pipeline/run-driver',
};

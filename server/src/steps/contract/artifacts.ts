import { CODE_REVIEWERS, STEPS, type StepName } from '../../contract/steps';
import { REBASE_CONFLICT, REBASE_JOURNAL } from '../../git/rebase';
import type { Issue } from './step-contract';
import { CONTRACT_KIND, SUBTASKS_KIND, type Subtask } from '../../contract/subtask';
import { requirementsView } from '../../contract/requirements-view';
import {
  artifact,
  artifactFamily,
  firstLine,
  jsonArrayCodec,
  linesCodec,
  listSummary,
  type Artifact,
  type ArtifactFamily,
} from './artifact';

const WORK_STEPS: readonly StepName[] = STEPS.filter((step) => step !== 'done');
const AGENT_STEPS: readonly StepName[] = ['research', 'plan', 'plan-improve', 'implement', 'implement-improve'];

/** The title of the requirements, or the first line of a body that is not a requirements record. */
function summarizeRequirements(body: string): string {
  return requirementsView(body)?.title || firstLine(body.replace(/^#+\s*/gm, ''));
}

/** `<n> checklist items: <first item>` of the plan inside a requirements document. */
export function summarizePlan(body: string): string | null {
  const plan = requirementsView(body)?.plan;
  return plan && plan.items.length > 0 ? listSummary(plan.items.length, 'checklist items', plan.items[0]) : null;
}

/** `pass`, or `fail: <job>` for the job the log names first. */
function summarizePipeline(body: string): string {
  const result = /^result:\s*(\S+)/m.exec(body)?.[1] ?? '';
  if (result === 'fail') {
    const job = /^job:\s*(.+)$/m.exec(body)?.[1];
    return job ? `fail: ${job.trim()}` : 'fail';
  }
  return result === 'pass' ? 'pass' : firstLine(body);
}

/** The decision of a review and the first line of what it found. */
export function summarizeReview(body: string): string {
  const decision = /^decision:\s*(ok|return)\b/m.exec(body)?.[1];
  const first = firstLine(
    body
      .split('\n')
      .filter((line) => !/^decision:/.test(line.trim()))
      .join('\n'),
  );
  return [decision ? `decision: ${decision}` : '', first].filter(Boolean).join(' · ');
}

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
      'checks',
      'code-review',
      'commit',
      'merge-request',
      'pipeline',
    ],
    summarize: summarizeRequirements,
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
      'checks',
      'code-review',
      'commit',
      'merge-request',
      'pipeline',
    ],
    codec: linesCodec,
    summarize: (names) => names.join(', '),
  }),
  addedRepos: artifact('added_repos', {
    writers: ['prepare'],
    readers: ['prepare', 'plan', 'plan-improve', 'implement', 'implement-improve'],
    summarize: firstLine,
  }),
  pendingRepos: artifact('pending_repos', { writers: ['prepare'], readers: ['prepare'], summarize: firstLine }),
  handoff: artifact('handoff', { writers: [], readers: WORK_STEPS, external: true, summarize: firstLine }),
  return: artifact('return', {
    writers: ['code-review', 'pipeline'],
    readers: ['implement', 'implement-improve'],
    summarize: firstLine,
  }),
  issues: artifact('issues', {
    writers: ['checks', 'code-review', 'pipeline'],
    readers: ['checks', 'implement', 'implement-improve'],
    codec: jsonArrayCodec<Issue>(),
    summarize: (issues) => listSummary(issues.length, 'issues', issues[0]?.title),
  }),
  implementation: artifact('implementation', {
    writers: ['implement', 'implement-improve'],
    readers: ['implement', 'implement-improve', 'code-review', 'merge-request'],
    summarize: firstLine,
  }),
  answers: artifact('answers', { writers: [], readers: ['research', 'plan'], external: true, summarize: firstLine }),
  questions: artifact('questions', { writers: ['research', 'plan'], readers: ['plan'], summarize: firstLine }),
  impact: artifact('impact', {
    writers: ['research'],
    readers: ['plan', 'plan-improve', 'code-review'],
    summarize: firstLine,
  }),
  subtasks: artifact(SUBTASKS_KIND, {
    writers: ['plan', 'plan-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve'],
    codec: jsonArrayCodec<Subtask>(),
    summarize: (tasks) => listSummary(tasks.length, 'tasks', tasks[0]?.title),
  }),
  contract: artifact(CONTRACT_KIND, {
    writers: ['plan', 'plan-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve'],
    summarize: firstLine,
  }),
  pipelineRef: artifact('pipeline_ref', {
    writers: ['commit', 'implement'],
    readers: ['branch', 'implement', 'pipeline'],
    summarize: firstLine,
  }),
  pipelineLog: artifact('pipeline_log', {
    writers: ['pipeline'],
    readers: ['pipeline', 'implement', 'implement-improve'],
    summarize: summarizePipeline,
  }),
  pipelineRebases: artifact('pipeline_rebases', { writers: ['pipeline'], readers: ['pipeline'], summarize: firstLine }),
  ciSkip: artifact('ci_skip', {
    writers: ['commit'],
    readers: ['commit', 'merge-request', 'pipeline'],
    summarize: firstLine,
  }),
  unfixedIssue: artifact('unfixed_issue', { writers: ['implement'], readers: ['implement'], summarize: firstLine }),
  ciRerun: artifact('ci_rerun', { writers: ['implement'], readers: ['commit'], summarize: firstLine }),
  rebaseConflict: artifact(REBASE_CONFLICT, {
    writers: ['implement', 'code-review'],
    readers: ['implement', 'code-review'],
    summarize: firstLine,
  }),
  rebaseMergeSkip: artifact('rebase_merge_skip', {
    writers: ['implement', 'merge-request'],
    readers: ['merge-request'],
    summarize: firstLine,
  }),
  commit: artifact('commit', { writers: ['commit'], readers: ['commit'], summarize: firstLine }),
  mergeRequest: artifact('merge_request', { writers: ['merge-request'], readers: [], summarize: firstLine }),
  reviewReport: artifact('review_report', {
    writers: ['code-review'],
    readers: ['merge-request'],
    summarize: firstLine,
  }),
  requirementsProgress: artifact('requirements_progress', {
    writers: ['requirements'],
    readers: ['requirements'],
    summarize: firstLine,
  }),
  pending: artifact('pending', { writers: ['requirements'], readers: [], summarize: firstLine }),
  error: artifact('error', { writers: [], readers: [], external: true, summarize: firstLine }),
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
  [REBASE_JOURNAL]: 'git/rebase/journal',
  loop_mark: 'pipeline/run-driver',
  spend: 'pipeline/run-driver',
};

import { CODE_REVIEWERS, STEPS, type StepName } from '../../contract/steps';
import { REBASE_CONFLICT, REBASE_JOURNAL } from '../../git/rebase';
import type { Issue } from './step-contract';
import { CONTRACT_KIND, SUBTASKS_KIND, type Subtask } from '../../contract/subtask';
import type { KeepLine } from '../shared/keep-lines';
import { research, type ResearchResult } from '../../agent-result/definitions/research';
import { plan, type PlanResult } from '../../agent-result/definitions/plan';
import { planImprove, type PlanImproveResult } from '../../agent-result/definitions/plan-improve';
import { implementation, type ImplementationResult } from '../../agent-result/definitions/implementation';
import {
  implementationImprove,
  type ImplementationImproveResult,
} from '../../agent-result/definitions/implementation-improve';
import { rebaseResolution, type RebaseResolutionResult } from '../../agent-result/definitions/rebase-resolution';
import { reviewReport, type ReviewReportResult } from '../../agent-result/definitions/review-report';
import { reviewDefinition, type ReviewResult } from '../../agent-result/definitions/review';
import { legacyReview } from '../../agent-result/legacy/review';
import { subtaskAnswer, type SubtaskAnswerResult } from '../../agent-result/definitions/subtask-answer';
import { resultArtifactCodec } from '../../agent-result/result-codec';
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
function reviewLine(decision: string | undefined, text: string): string {
  return [decision ? `decision: ${decision}` : '', firstLine(text)].filter(Boolean).join(' · ');
}

/** The line of a rendered review, for a run from before results were stored. */
export function summarizeReview(body: string): string {
  const review = legacyReview(body);
  return reviewLine(review?.decision, review?.review ?? body);
}

export function summarizeReviewResult(result: ReviewResult): string {
  return reviewLine(result.decision, result.review);
}

/** `review_<reviewer>_result`: one reviewer's validated object, stored and read through its own definition. */
function reviewResultArtifact(reviewer: (typeof CODE_REVIEWERS)[number]): Artifact<ReviewResult> {
  const definition = reviewDefinition(reviewer);
  return artifact(definition.kind, {
    writers: ['code-review'],
    readers: ['code-review', 'commit'],
    codec: resultArtifactCodec<ReviewResult>(definition),
    summarize: summarizeReviewResult,
  });
}

/** The kind of the agent log, which old runs stored as a document. */
export const LOG_KIND = 'log';

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
    writers: ['checks', 'code-review', 'pipeline', 'commit'],
    readers: ['checks', 'implement', 'implement-improve'],
    codec: jsonArrayCodec<Issue>(),
    summarize: (issues) => listSummary(issues.length, 'issues', issues[0]?.title),
  }),
  implementation: artifact('implementation', {
    writers: ['implement', 'implement-improve'],
    readers: ['implement', 'implement-improve', 'code-review', 'merge-request'],
    summarize: firstLine,
  }),
  // `plan-improve` and the implement steps read the corrected checklist through `currentPlan`; `implement` reads it to settle a rebase and for `currentPlan`; the split parent writes it with its task lines.
  implementationResult: artifact(implementation.kind, {
    writers: ['implement', 'implement-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve', 'code-review', 'merge-request'],
    codec: resultArtifactCodec<ImplementationResult>(implementation),
    summarize: (result) => listSummary(result.implementation.length, 'changes', result.implementation[0]),
  }),
  // The corrected checklist of this pass is read through `currentPlan` by both implement steps.
  implementationImproveResult: artifact(implementationImprove.kind, {
    writers: ['implement-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve', 'code-review'],
    codec: resultArtifactCodec<ImplementationImproveResult>(implementationImprove),
    summarize: (result) => listSummary(result.implementation?.length ?? 0, 'changes', result.implementation?.[0]),
  }),
  // What the agent said of a rebase conflict; kept for the record, no step reads it.
  rebaseResolutionResult: artifact(rebaseResolution.kind, {
    writers: ['implement'],
    readers: [],
    codec: resultArtifactCodec<RebaseResolutionResult>(rebaseResolution),
    summarize: (result) => firstLine(result.summary[0] ?? ''),
  }),
  answers: artifact('answers', { writers: [], readers: ['research', 'plan'], external: true, summarize: firstLine }),
  questions: artifact('questions', { writers: ['research', 'plan'], readers: ['plan'], summarize: firstLine }),
  needs: artifact('needs', { writers: ['research', 'plan', 'implement'], readers: [], summarize: firstLine }),
  impact: artifact('impact', {
    writers: ['research'],
    readers: ['plan', 'plan-improve', 'code-review'],
    summarize: firstLine,
  }),
  researchResult: artifact(research.kind, {
    writers: ['research'],
    readers: ['plan', 'plan-improve', 'code-review'],
    codec: resultArtifactCodec<ResearchResult>(research),
    summarize: (result) => `${listSummary(result.questions.length, 'questions', result.questions[0])}`,
  }),
  planResult: artifact(plan.kind, {
    writers: ['plan'],
    readers: ['plan', 'plan-improve', 'implement', 'implement-improve', 'code-review'],
    codec: resultArtifactCodec<PlanResult>(plan),
    summarize: (result) => listSummary(result.plan.length || result.tasks.length, 'plan items', result.plan[0]),
  }),
  planImproveResult: artifact(planImprove.kind, {
    writers: ['plan-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve', 'code-review'],
    codec: resultArtifactCodec<PlanImproveResult>(planImprove),
    summarize: (result) => listSummary(result.plan.length || result.tasks.length, 'plan items', result.plan[0]),
  }),
  // The parent planner's answer to a subtask, written by the pipeline and not by a step.
  subtaskAnswerResult: artifact(subtaskAnswer.kind, {
    writers: [],
    readers: [],
    external: true,
    codec: resultArtifactCodec<SubtaskAnswerResult>(subtaskAnswer),
    summarize: (result) => firstLine(result.answer),
  }),
  subtasks: artifact(SUBTASKS_KIND, {
    writers: ['plan', 'plan-improve', 'implement'],
    readers: ['plan-improve', 'branch', 'implement', 'implement-improve'],
    codec: jsonArrayCodec<Subtask>(),
    summarize: (tasks) => listSummary(tasks.length, 'tasks', tasks[0]?.title),
  }),
  keep: artifact('keep', {
    writers: ['plan', 'plan-improve'],
    readers: ['plan-improve', 'code-review'],
    codec: jsonArrayCodec<KeepLine>(),
    summarize: (lines) => listSummary(lines.length, 'kept capabilities', lines[0]?.capability),
  }),
  contract: artifact(CONTRACT_KIND, {
    writers: ['plan', 'plan-improve', 'implement'],
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
  ciWaits: artifact('ci_waits', { writers: ['pipeline'], readers: ['pipeline'], summarize: firstLine }),
  flaky: artifact('flaky', { writers: ['pipeline'], readers: ['pipeline'], summarize: firstLine }),
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
  /** The files a merged task changed, one path per line, read from its merge into the feature branch. */
  mergedFiles: artifact('merged_files', { writers: [], readers: [], external: true, summarize: firstLine }),
  pendingRebase: artifact('pending_rebase', { writers: [], readers: [], external: true, summarize: firstLine }),
  commit: artifact('commit', { writers: ['commit'], readers: ['commit'], summarize: firstLine }),
  mergeRequest: artifact('merge_request', {
    writers: ['merge-request', 'pipeline'],
    readers: ['pipeline'],
    summarize: firstLine,
  }),
  reviewReport: artifact('review_report', {
    writers: ['code-review'],
    readers: ['merge-request'],
    summarize: firstLine,
  }),
  // The parts of the report the document is rendered from; the merge request reads it.
  reviewReportResult: artifact(reviewReport.kind, {
    writers: ['code-review'],
    readers: ['merge-request'],
    codec: resultArtifactCodec<ReviewReportResult>(reviewReport),
    summarize: (result) => firstLine(result.whatChanged),
  }),
  reviewRequirementsResult: reviewResultArtifact('requirements'),
  reviewQualityResult: reviewResultArtifact('quality'),
  reviewRegressionsResult: reviewResultArtifact('regressions'),
  reviewSecurityResult: reviewResultArtifact('security'),
  reviewPerformanceResult: reviewResultArtifact('performance'),
  requirementsProgress: artifact('requirements_progress', {
    writers: ['requirements'],
    readers: ['requirements'],
    summarize: firstLine,
  }),
  pending: artifact('pending', { writers: ['requirements'], readers: [], summarize: firstLine }),
  // The driver and reviewers read a failed agent's validation errors on its next launch; the visit owns the record.
  answerErrors: artifact('answer_errors', {
    writers: [],
    readers: ['code-review'],
    external: true,
    codec: jsonArrayCodec<string>(),
    summarize: (errors) => (errors.length === 0 ? '' : `${errors.length} errors in the agent's answer`),
  }),
  error: artifact('error', { writers: [], readers: [], external: true, summarize: firstLine }),
  log: artifact(LOG_KIND, { writers: [], readers: [], external: true, summarize: firstLine }),
} as const satisfies Record<string, Artifact<unknown>>;

/** The contract entry of a kind, when it has one. */
export function artifactOf(kind: string): Artifact<unknown> | undefined {
  return Object.values<Artifact<unknown>>(ARTIFACTS).find((item) => item.kind === kind);
}

/** `instructions:<step>`, written when a person gives a step new instructions. */
export const INSTRUCTIONS: ArtifactFamily = artifactFamily('instructions:', AGENT_STEPS);

/** `review_<reviewer>`, written by the code-review step. */
export const REVIEWS: ArtifactFamily = artifactFamily('review_', CODE_REVIEWERS);

/** The `review_<reviewer>_result` entry of each reviewer. */
export const REVIEW_RESULTS: Readonly<Record<(typeof CODE_REVIEWERS)[number], Artifact<ReviewResult>>> = {
  requirements: ARTIFACTS.reviewRequirementsResult,
  quality: ARTIFACTS.reviewQualityResult,
  regressions: ARTIFACTS.reviewRegressionsResult,
  security: ARTIFACTS.reviewSecurityResult,
  performance: ARTIFACTS.reviewPerformanceResult,
};

/** The registry entry of one reviewer's result. Throws for a name that is no reviewer. */
export function reviewResultOf(reviewer: string): Artifact<ReviewResult> {
  const found = Object.entries(REVIEW_RESULTS).find(([name]) => name === reviewer);
  if (!found) {
    throw new Error(`${reviewer} is not a code reviewer`);
  }
  return found[1];
}

/** Kinds owned outside `steps`, each with the module that owns it. */
export const SERVICE_KINDS: Readonly<Record<string, string>> = {
  chat_lock: 'pipeline/chat-lock',
  shell_resume: 'pipeline/worktree-snapshot',
  snapshot: 'pipeline/worktree-snapshot',
  environment: 'environment/project-environments',
  checks_pass: 'environment/project-environments',
  checks_skipped: 'environment/project-environments',
  [REBASE_JOURNAL]: 'git/rebase/journal',
  loop_mark: 'pipeline/run-driver',
  spend: 'pipeline/run-driver',
};

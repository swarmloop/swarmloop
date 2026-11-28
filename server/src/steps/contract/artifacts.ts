import { CODE_REVIEWERS, RETIRED_REVIEWERS, STEPS, type StepName, type StoredReviewer } from '../../contract/steps';
import { REBASE_CONFLICT, REBASE_JOURNAL } from '../../git/rebase';
import type { Issue } from './step-contract';
import { SPLIT_ARTIFACTS } from './artifacts-split';
import type { CoveredRequirement, Requirement } from '../../contract/requirement-list';
import type { KeepLine } from '../shared/keep-lines';
import type { PassedOn, StoredQuestion } from '../shared/question-parts';
import { research, type ResearchResult } from '../../agent-result/definitions/research';
import { plan, type PlanResult } from '../../agent-result/definitions/plan';
import { planImprove, type PlanImproveResult } from '../../agent-result/definitions/plan-improve';
import { implementationAfterReview, type ImplementationResult } from '../../agent-result/definitions/implementation';
import {
  implementationImproveAfterReview,
  type ImplementationImproveResult,
} from '../../agent-result/definitions/implementation-improve';
import { rebaseResolution, type RebaseResolutionResult } from '../../agent-result/definitions/rebase-resolution';
import { reviewReport, isLegacyReport } from '../../agent-result/definitions/review-report';
import { reviewReportCodec } from '../../agent-result/review-report-codec';
import { reviewDefinition, reviewStoredDefinition, type ReviewResult } from '../../agent-result/definitions/review';
import { resultArtifactCodec } from '../../agent-result/result-codec';
import { PLAN_CHAT_KIND, readPlanChat, type PlanChatLog } from '../../contract/plan-chat';
import { pipelineRefSummary } from './pipeline-ref-summary';
import { deliverySummary, formatDelivery, parseDelivery } from './delivery-list';
import { summarizePipeline, summarizeRequirements, summarizeReviewResult } from './artifact-summaries';
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

/** `review_<reviewer>_result`: one reviewer's validated object, stored and read through its own definition. */
function reviewResultArtifact(reviewer: StoredReviewer): Artifact<ReviewResult> {
  const definition = reviewDefinition(reviewer);
  const retired = RETIRED_REVIEWERS.some((name) => name === reviewer);
  return artifact(definition.kind, {
    // A retired reviewer is never started again: its documents are only read, so no step writes them.
    writers: retired ? [] : ['code-review'],
    external: retired,
    readers: ['code-review', 'commit'],
    codec: resultArtifactCodec<ReviewResult>(reviewStoredDefinition(reviewer)),
    summarize: summarizeReviewResult,
  });
}

/** The kind of the agent log, which old runs stored as a document. */
export const LOG_KIND = 'log';

/** Every kind a step reads or writes. */
export const ARTIFACTS = {
  requirements: artifact('requirements', {
    writers: ['requirements', 'plan', 'plan-improve', 'implement', 'implement-improve', 'code-review'],
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
  implementationResult: artifact(implementationAfterReview.kind, {
    writers: ['implement', 'implement-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve', 'code-review', 'merge-request'],
    codec: resultArtifactCodec<ImplementationResult>(implementationAfterReview),
    summarize: (result) => listSummary(result.implementation.length, 'changes', result.implementation[0]),
  }),
  // The corrected checklist of this pass is read through `currentPlan` by both implement steps.
  implementationImproveResult: artifact(implementationImproveAfterReview.kind, {
    writers: ['implement-improve'],
    readers: ['plan-improve', 'implement', 'implement-improve', 'code-review'],
    codec: resultArtifactCodec<ImplementationImproveResult>(implementationImproveAfterReview),
    summarize: (result) => listSummary(result.implementation?.length ?? 0, 'changes', result.implementation?.[0]),
  }),
  // What the agent said of a rebase conflict; kept for the record, no step reads it.
  rebaseResolutionResult: artifact(rebaseResolution.kind, {
    writers: ['implement'],
    readers: [],
    codec: resultArtifactCodec<RebaseResolutionResult>(rebaseResolution),
    summarize: (result) => firstLine(result.summary[0] ?? ''),
  }),
  answers: artifact('answers', {
    writers: [],
    readers: ['research', 'plan', 'implement'],
    external: true,
    summarize: firstLine,
  }),
  questions: artifact('questions', { writers: ['research', 'plan'], readers: ['plan'], summarize: firstLine }),
  // What the code review asks the person when a reviewer returns the same diff again; `answers` closes it.
  reviewQuestions: artifact('review_questions', {
    writers: ['code-review'],
    readers: ['implement'],
    summarize: firstLine,
  }),
  // The open questions of review_questions and subtask_questions in parts; the text of a question is the key to its parts.
  questionParts: artifact('question_parts', {
    writers: ['code-review', 'implement'],
    readers: ['implement'],
    codec: jsonArrayCodec<StoredQuestion>(),
    summarize: (questions) => listSummary(questions.length, 'questions', questions[0]?.parts.decide),
  }),
  // The questions of a backlog's run that the backlog's planner passed on to the person, each with its line; written by the pass-on service.
  passedOn: artifact('passed_on', {
    writers: [],
    readers: [],
    external: true,
    codec: jsonArrayCodec<PassedOn>(),
    summarize: (passed) => listSummary(passed.length, 'passed on questions', passed[0]?.line),
  }),
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
  ...SPLIT_ARTIFACTS,
  requirementList: artifact('requirement_list', {
    writers: ['research', 'plan', 'plan-improve'],
    readers: ['research', 'plan', 'plan-improve', 'code-review'],
    codec: jsonArrayCodec<Requirement>(),
    summarize: (list) => listSummary(list.length, 'requirements', list[0]?.text),
  }),
  requirementCoverage: artifact('requirement_coverage', {
    writers: ['plan', 'plan-improve'],
    readers: ['plan-improve', 'implement', 'code-review'],
    codec: jsonArrayCodec<CoveredRequirement>(),
    summarize: (list) => listSummary(list.length, 'requirements', list[0]?.text),
  }),
  keep: artifact('keep', {
    writers: ['plan', 'plan-improve'],
    readers: ['plan-improve', 'code-review'],
    codec: jsonArrayCodec<KeepLine>(),
    summarize: (lines) => listSummary(lines.length, 'kept capabilities', lines[0]?.capability),
  }),
  // The branch name of each repository, stored by the branch step (which declares it when it writes it); every later step reads it.
  branchNames: artifact('branch_names', {
    writers: [],
    external: true,
    readers: ['implement', 'implement-improve', 'commit', 'merge-request', 'pipeline'],
    summarize: firstLine,
  }),
  // What a host said when it refused a push or a title, and the refused name; the implement step answers it once.
  gitRefusal: artifact('git_refusal', {
    writers: [],
    external: true,
    readers: ['implement'],
    summarize: firstLine,
  }),
  // The git rules the agent learned and the server could not write into the repository; the merge request ends with them.
  gitRulesNote: artifact('git_rules_note', {
    writers: ['implement', 'implement-improve'],
    readers: ['merge-request'],
    summarize: firstLine,
  }),
  pipelineRef: artifact('pipeline_ref', {
    writers: ['commit', 'implement'],
    readers: ['branch', 'commit', 'implement', 'pipeline'],
    summarize: pipelineRefSummary,
  }),
  // One entry per repository of the run: read, publishing or published. Commit decides read through hasOwnWork; the merge request step marks published.
  delivery: artifact('delivery', {
    writers: ['commit', 'merge-request'],
    readers: ['commit', 'merge-request', 'pipeline'],
    codec: { parse: parseDelivery, format: formatDelivery },
    summarize: deliverySummary,
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
  pendingRebase: artifact('pending_rebase', { writers: [], readers: [], external: true, summarize: firstLine }),
  commit: artifact('commit', { writers: ['commit', 'merge-request'], readers: ['commit'], summarize: firstLine }),
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
    codec: reviewReportCodec,
    summarize: (result) => firstLine(isLegacyReport(result) ? result.whatChanged : result.line),
  }),
  reviewRequirementsResult: reviewResultArtifact('requirements'),
  reviewCodeResult: reviewResultArtifact('code'),
  reviewBehaviorResult: reviewResultArtifact('behavior'),
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
  // The plan chat of a run: the person's messages, the planner's replies and the plan revisions.
  planChat: artifact(PLAN_CHAT_KIND, {
    writers: [],
    readers: [],
    external: true,
    codec: { parse: readPlanChat, format: (log: PlanChatLog) => `${JSON.stringify(log)}\n` },
    summarize: (log) => `${log.entries.length} messages, ${log.revisions.length} plan revisions`,
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

/** The `review_<reviewer>_result` entry of each reviewer a run can have stored, the retired ones included. */
export const REVIEW_RESULTS: Readonly<Record<StoredReviewer, Artifact<ReviewResult>>> = {
  requirements: ARTIFACTS.reviewRequirementsResult,
  code: ARTIFACTS.reviewCodeResult,
  behavior: ARTIFACTS.reviewBehaviorResult,
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
  environment: 'environment/project-environments',
  checks_pass: 'environment/project-environments',
  checks_skipped: 'environment/project-environments',
  command_passes: 'environment/check-passes',
  [REBASE_JOURNAL]: 'git/rebase/journal',
  loop_mark: 'pipeline/run-driver',
  spend: 'pipeline/run-driver',
  stop_cleanup: 'pipeline/stopped-cleanup',
  epic_stopped_tasks: 'pipeline/subtask-wakes',
  question_levels: 'pipeline/planner-chain',
};

import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { countedVisits, isLoopStep, loopMark } from '../../core/pipeline-result';
import { isReturned, liveState, storedState, type LiveFacts } from '../../history/run-state';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../../contract/error-codes';
import { actionsFor, REASON } from '../../contract/run-state';
import { parseSubtasks, statusLine, SUBTASKS_KIND } from '../../contract/subtask';
import type { RunAction, RunState, StateReason } from '../../contract/run-state';
import type { FlowItem, FlowView } from '../../contract/api';
import { parkedConflictIn } from '../../pipeline/parked-conflict';
import { CHECK_BLOCK_SENTENCE } from '../../steps/shared/check-block-resume';
import { latest } from './status';

/** The honest state of the run and what the server allows in it. */
export function stateView(
  run: RunEntity,
  live: LiveFacts,
  stored: { parkedConflict?: boolean } = {},
): { state: RunState; reason: StateReason | null; actions: RunAction[] } {
  const { state, reason } = liveState(run, live);
  return { state, reason, actions: actionsFor(state, reason?.code ?? null, stored) };
}

export function resumeState(
  run: RunEntity,
  open: FlowItem[],
  stored: { parkedConflict?: boolean } = {},
): FlowView['resume'] {
  const { state, actions } = stateView(run, {}, stored);
  if (state === 'done') {
    return 'done';
  }
  if (state === 'running' || state === 'stopping') {
    return 'running';
  }
  if (state === 'blocked') {
    return actions.includes('resume') ? 'ready' : 'blocked';
  }
  if (open.some((item) => item.answer.trim() === '')) {
    return 'need-answers';
  }
  return 'ready';
}

export function withSkip(said: string, step: string, skip: string | null): string {
  const note = skip?.trim() ?? '';
  if (!note || step === 'commit') {
    return said;
  }
  return `${note} ${said}`;
}

function doneSentence(run: RunEntity): string {
  const { state } = storedState(run);
  if (state === 'merged') return 'This run is merged: its merge request is in the target branch.';
  if (state === 'closed')
    return 'This run is closed: its merge request was closed without a merge. Replay starts it again.';
  return 'This run is done: its merge request is ready to merge.';
}

const OUTAGE_NAMES: Record<string, string> = {
  [ERROR_CODES.HOST_UNAVAILABLE]: 'A host did not answer.',
  [ERROR_CODES.CI_NOT_STARTED]: 'The host has not started CI for the commit.',
  [ERROR_CODES.DOCKER_UNAVAILABLE]: 'Docker did not answer.',
};

/** What happens next for the codes that carry their own next step, or null for any other. */
function codeSentence(run: RunEntity, maxReturns: number): string | null {
  const { state, reason } = storedState(run);
  if (state === 'waiting' && reason && reason.code in OUTAGE_NAMES) {
    const when = reason.retryAt ? ` at ${reason.retryAt}` : '';
    return `${OUTAGE_NAMES[reason.code]} The step is tried again by itself${when}. Resume tries now.`;
  }
  if (state === 'waiting' && reason?.code === REASON.stalled) return reason.message;
  if (state === 'skipped' && reason) return reason.message;
  if (state !== 'blocked' || !reason) return null;
  if (reason.code === REASON.loopLimit) {
    return `Automatic retries stopped after ${maxReturns} attempts. Resume starts another.`;
  }
  if (reason.code === ERROR_CODES.SPEND_LIMIT) {
    return 'The run spent as much as MAX_RUN_USD allows. Raise MAX_RUN_USD, then Resume.';
  }
  if (reason.code === ERROR_CODES.PIPELINE_UNFIXED) {
    return 'The failed pipeline job failed twice on the same commit and the agent changed nothing. Check the CI settings, the secrets, or a failure outside the change, then Resume.';
  }
  return null;
}

function blockedSentence(run: RunEntity, maxReturns: number, parkedConflict: boolean): string {
  const code = storedState(run).reason?.code;
  if (code === ERROR_CODES.REBASE_CONFLICT && parkedConflict) {
    return 'The rebase stopped at a conflict with the base branch. Resume has the implement agent resolve it; checks and code review judge the resolution, then the open tasks move onto the resolved branch.';
  }
  if (code === REASON.checkFailed) {
    return CHECK_BLOCK_SENTENCE;
  }
  if (code === REASON.didNotFit) {
    return run.currentStep === 'code-review'
      ? 'This step cannot start with the remaining agent-call budget. Resume retries from stored reviews.'
      : 'This step cannot start with the remaining agent-call budget. Resume runs it anyway.';
  }
  return isLoopStep(run.currentStep)
    ? `Automatic retries stopped after ${maxReturns} attempts. Resume starts another.`
    : 'This run is blocked. Another return is not available.';
}

export function sentence(
  run: RunEntity,
  open: FlowItem[],
  documents: DocumentEntity[],
  stats: StepStatEntity[],
  maxReturns: number,
): string {
  const coded = codeSentence(run, maxReturns);
  if (coded) {
    return coded;
  }
  if (run.status === 'blocked') {
    return blockedSentence(run, maxReturns, parkedConflictIn(documents, run));
  }
  if (run.status === 'waiting' && isLoopStep(run.currentStep)) {
    const visits = countedVisits(stats, run.currentStep, loopMark(latest(documents, 'loop_mark')));
    if (visits >= maxReturns) {
      return `Automatic retries stopped after ${maxReturns} attempts. Resume starts another.`;
    }
  }
  if (run.status === 'failed') {
    return 'This step failed. Resume retries it.';
  }
  if (run.status === 'done') {
    return doneSentence(run);
  }
  if (run.status === 'running') {
    return 'This step is running. The output is below.';
  }
  const held = spendHold(run, documents, stats);
  if (held) {
    return held;
  }
  if (open.some((item) => item.kind === 'paste')) {
    return 'A link still needs a pasted body before the run can continue.';
  }
  if (open.some((item) => item.kind === 'question')) {
    return open.every((item) => item.kind !== 'question' || item.holder === 'planner')
      ? "The backlog's planner has the open questions. You can still answer them here."
      : 'Answer the open questions before the run continues.';
  }
  if (run.currentStep === 'commit' && run.status === 'waiting') {
    return 'Resume stages the paths below and pushes the feature branch.';
  }
  if (run.currentStep === 'prepare') {
    return 'The next continuation prepares the worktrees.';
  }
  const subtasks = subtaskSentence(run, documents);
  if (subtasks) {
    return subtasks;
  }
  if (run.currentStep === 'implement' && run.status === 'waiting') {
    const returned = isReturned(run);
    return returned
      ? 'The next continuation returns to implementation.'
      : 'The next continuation implements the approved plan.';
  }
  return `The next continuation continues at ${run.currentStep}.`;
}

/** What a split run that waits for its subtasks says: their counts. Null for any other run. */
function subtaskSentence(run: RunEntity, documents: DocumentEntity[]): string | null {
  const code = storedState(run).reason?.code;
  if (run.status !== 'waiting' || !code || !SUBTASK_WAIT_CODES.some((wait) => wait === code)) {
    return null;
  }
  const tasks = parseSubtasks(latest(documents, SUBTASKS_KIND));
  return tasks.length > 0 ? `Waiting for subtasks: ${statusLine(tasks)}` : null;
}

/** The spend note holds a waiting run only while its step has not waited, failed or run since: that visit was a later resume. */
function spendHold(run: RunEntity, documents: DocumentEntity[], stats: StepStatEntity[]): string | null {
  if (run.status !== 'waiting') {
    return null;
  }
  const note = latest(documents, 'spend')?.trim() || null;
  const last = [...stats].reverse().find((item) => item.step === run.currentStep)?.status ?? null;
  return last === 'waiting' || last === 'failed' || last === 'running' ? null : note;
}

export function reason(run: RunEntity, documents: DocumentEntity[], stats: StepStatEntity[]): string | null {
  if (run.status !== 'blocked' && run.status !== 'failed') {
    return null;
  }
  if (storedState(run).state === 'skipped') return null;
  const stat = [...stats].reverse().find((item) => item.step === run.currentStep);
  const kind =
    run.currentStep === 'code-review' ? 'review_residual' : run.currentStep === 'pipeline' ? 'pipeline_log' : null;
  const current = stat ? documents.filter((document) => document.stepStatId === stat.id) : documents;
  const residual = (kind ? latest(current, kind) : null) ?? latest(current, 'error');
  const text = residual?.trim() || null;
  const head = stat?.killReason ?? null;
  if (text && head) {
    return `${head}\n${text}`;
  }
  return text ?? head;
}

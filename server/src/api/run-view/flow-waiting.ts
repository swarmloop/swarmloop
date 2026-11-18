import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { continuesSameStep, countedVisits, isLoopStep, loopMark } from '../../core/pipeline-result';
import { blockCode, deriveState, isReturned } from '../../history/run-state';
import { ERROR_CODES } from '../../contract/error-codes';
import { actionsFor, REASON } from '../../contract/run-state';
import type { StateFacts } from '../../history/run-state';
import type { RunAction, RunState, StateReason } from '../../contract/run-state';
import type { FlowItem, FlowView } from '../../contract/api';
import { latest } from './status';

/** The honest state of the run and what the server allows in it. */
export function stateView(
  run: RunEntity,
  open: FlowItem[],
  documents: DocumentEntity[],
  facts: StateFacts = {},
): { state: RunState; reason: StateReason | null; actions: RunAction[] } {
  const { state, reason } = deriveState(run, {
    ...facts,
    needsAnswers: open.length > 0,
    returned: isReturned(run),
    blockCode: run.status === 'blocked' ? blockCode(run.currentStep, latest(documents, 'error')) : undefined,
  });
  return { state, reason, actions: actionsFor(state, reason?.code ?? null) };
}

export function resumeState(run: RunEntity, open: FlowItem[], documents: DocumentEntity[]): FlowView['resume'] {
  const { state, actions } = stateView(run, open, documents);
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
  const { state } = deriveState(run);
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
  const { state, reason } = deriveState(run);
  if (state === 'waiting' && reason && reason.code in OUTAGE_NAMES) {
    const when = reason.retryAt ? ` at ${reason.retryAt}` : '';
    return `${OUTAGE_NAMES[reason.code]} The step is tried again by itself${when}. Resume tries now.`;
  }
  if (state === 'waiting' && reason?.code === REASON.stalled) return reason.message;
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

function blockedSentence(run: RunEntity, documents: DocumentEntity[], maxReturns: number): string {
  if (blockCode(run.currentStep, latest(documents, 'error')) === REASON.checkFailed) {
    return 'A required check failed again on unchanged files. Resume returns to implementation with the stored notes.';
  }
  return didNotFit(documents)
    ? run.currentStep === 'code-review'
      ? 'This step cannot start with the remaining agent-call budget. Resume retries from stored reviews.'
      : 'This step cannot start with the remaining agent-call budget. Resume runs it anyway.'
    : isLoopStep(run.currentStep)
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
    return blockedSentence(run, documents, maxReturns);
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
    return 'Answer the open questions before the run continues.';
  }
  if (run.currentStep === 'commit' && run.status === 'waiting') {
    return 'Resume stages the paths below and pushes the feature branch.';
  }
  if (run.currentStep === 'prepare') {
    return 'The next continuation prepares the worktrees.';
  }
  if (run.currentStep === 'implement' && run.status === 'waiting') {
    const returned = isReturned(run);
    return returned
      ? 'The next continuation returns to implementation.'
      : 'The next continuation implements the approved plan.';
  }
  return `The next continuation continues at ${run.currentStep}.`;
}

function spendHold(run: RunEntity, documents: DocumentEntity[], stats: StepStatEntity[]): string | null {
  if (run.status !== 'waiting') {
    return null;
  }
  const note = latest(documents, 'spend')?.trim() || null;
  if (!note) {
    return null;
  }
  const last = [...stats].reverse().find((item) => item.step === run.currentStep)?.status ?? null;
  if (continuesSameStep(run.status, run.currentStep, run.currentStep, last)) {
    return null;
  }
  return note;
}

export function reason(run: RunEntity, documents: DocumentEntity[], stats: StepStatEntity[]): string | null {
  if (run.status !== 'blocked' && run.status !== 'failed') {
    return null;
  }
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

function didNotFit(documents: DocumentEntity[]): boolean {
  return (latest(documents, 'error') ?? '').includes('does not fit');
}

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { liveLogFinished, logStillOpen } from '../../agent/live-output';
import type { OutputFiles } from '../../core/attempt-output';
import { runFileName } from '../../core/run-files';
import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { launchCount } from '../../agent/agent-launches';
import { CODE_REVIEWERS, isReviewStep, pipelineStepOf, requireReviewer } from '../../contract/steps';
import { reviewLogDecision } from '../../contract/readable-log-review';
import { storedReview } from '../../agent-result/stored-review';
import { LIMIT_VISIT } from '../../history/visit.repository';
import { stepStatus, latest } from './status';
import type { FlowView } from '../../contract/api';
import { REVIEW_KINDS } from './run-view.types';
import type { OpenReviewRound } from '../../steps/shared/open-review-rounds';
import { wordList } from '../../core/word-list';

/** The log of one reviewer or the report, only when it was written since the open round began. */
export function roundLog(outputs: OutputFiles, run: RunEntity, name: string): string {
  const path = outputs.path(run.key, name, run.activeAttempt);
  if (!path) {
    return '';
  }
  const started = Date.parse(run.stepStartedAt ?? '');
  try {
    if (Number.isFinite(started) && statSync(path).mtimeMs < started) {
      return '';
    }
  } catch {
    return '';
  }
  return outputs.read(run.key, name, run.activeAttempt);
}

/** True while code-review runs: its reviewers and its report belong to the round that began at `stepStartedAt`. */
function roundOpen(run: RunEntity): boolean {
  return run.status === 'running' && run.currentStep === 'code-review';
}

/** The latest decision stored for a reviewer: its result, or for an older run its rendered review. */
function storedDecision(documents: DocumentEntity[], reviewer: string): 'ok' | 'return' | null {
  return storedReview(reviewer, documents)?.decision ?? null;
}

/** `ok` is done, `return` is returned, and anything else is what the caller says. */
export function decisionStatus(decision: 'ok' | 'return' | null, otherwise: string): string {
  return decision === 'ok' ? 'done' : decision === 'return' ? 'returned' : otherwise;
}

export function chipStatus(
  name: string,
  run: RunEntity,
  stat: StepStatEntity | undefined,
  documents: DocumentEntity[],
  round: { attempts: number; status: string } | null,
  /** The last log of a reviewer that has no stored visit of its own, when no round is open. */
  log = '',
): string {
  if (!isReviewStep(name)) {
    return stepStatus(pipelineStepOf(name), run, stat);
  }
  if (round) {
    return round.status;
  }
  const status =
    stat?.step === name
      ? storedReviewerStatus(stat, documents, requireReviewer(name))
      : storedReviewerChip(run, documents, name, log);
  return settledEarlier(run, status);
}

/** A return from before the round that runs now was answered by implement: it reads like any finished step. */
function settledEarlier(run: RunEntity, status: string): string {
  return roundOpen(run) && status === 'returned' ? 'done' : status;
}

function storedReviewerChip(run: RunEntity, documents: DocumentEntity[], name: string, log: string): string {
  const saved = storedDecision(documents, requireReviewer(name));
  const fromLog = reviewLogDecision(log);
  const decision = run.currentStep === 'code-review' && fromLog ? fromLog : (saved ?? fromLog);
  return decisionStatus(decision, hasOutput(log) ? 'failed' : 'idle');
}

/** A log that holds output of an attempt: still being written, or finished. */
export function hasOutput(body: string): boolean {
  return logStillOpen(body) || liveLogFinished(body);
}

/** True while code-review is open and none of its reviewers or its report has written a log in this round: the step is still preparing. */
export function reviewPreparing(outputs: OutputFiles, run: RunEntity): boolean {
  if (!roundOpen(run)) {
    return false;
  }
  const names = [...REVIEW_KINDS.map((kind) => `code-review-${kind.slice('review_'.length)}`), 'code-review-report'];
  return names.every((name) => roundLog(outputs, run, name).trim() === '');
}

/** Where a reviewer or the report stands in the open round, from what it wrote in this round only. */
function roundStanding(
  body: string,
  prior: number,
  preparing: boolean,
  decision: (body: string) => 'ok' | 'return' | null,
): { attempts: number; status: string } {
  if (liveLogFinished(body)) {
    return { attempts: prior + 1, status: decisionStatus(decision(body), 'failed') };
  }
  if (logStillOpen(body)) {
    return { attempts: prior + 1, status: 'running' };
  }
  return { attempts: prior, status: preparing ? 'preparing' : 'running' };
}

/** A due report whose own agent has not started waits for the reviewers that still run. */
function waitingReport(attempts: number, working: string[]): FlowView['phases'][number]['steps'][number] {
  return {
    name: 'code-review',
    status: 'waiting',
    current: false,
    attempts,
    ...(working.length > 0 ? { note: `waits for ${wordList(working)}` } : {}),
  };
}

/**
 * The report is written after the angles. Until its own agent starts in the open round it waits; then it is
 * working until its own decision arrives. A round that does not write it shows what is stored.
 */
export function reportChip(
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  outputs: OutputFiles,
  preparing = false,
  round?: OpenReviewRound,
  working: string[] = [],
): FlowView['phases'][number]['steps'][number] {
  const saved = reportAttempts(stats, documents);
  if (roundOpen(run) && round?.reportDue && !round.reportStarted) {
    return waitingReport(saved, working);
  }
  if (roundOpen(run) && (!round || round.reportDue)) {
    const standing = roundStanding(
      roundLog(outputs, run, 'code-review-report'),
      saved,
      round ? false : preparing,
      reviewLogDecision,
    );
    return {
      name: 'code-review',
      status: standing.status,
      current: standing.status === 'running' || standing.status === 'preparing',
      attempts: standing.attempts,
    };
  }
  const verdict = angleVerdict(documents);
  const visit = stats.filter((item) => item.step === 'code-review').at(-1);
  const loopStatus = stepStatus('code-review', run, visit);
  const shown = settledEarlier(
    run,
    decisionStatus(verdict, (latest(documents, 'review_report') ?? '').trim() ? 'done' : 'idle'),
  );
  const status =
    run.currentStep !== 'code-review' && (loopStatus === 'failed' || loopStatus === 'returned') ? loopStatus : shown;
  return { name: 'code-review', status, current: false, attempts: saved };
}

/** The badge is the visit the detail lists. A relaunch inside that visit does not raise it. A stored step with no launch record stays 0. */
export function chipAttempts(
  name: string,
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  outputs: OutputFiles,
  round: { attempts: number; status: string } | null,
): number {
  if (isReviewStep(name)) {
    return round ? round.attempts : reviewerAttempts(name, stats, documents);
  }
  const last = agentVisits(stats.filter((stat) => stat.step === name));
  if (run.status === 'running' && run.currentStep === name) {
    return last + 1;
  }
  if (last === 0) {
    return 0;
  }
  const recorded = join(outputs.root, 'data', runFileName(run.key, name, 'launches'));
  if (!existsSync(recorded) || launchCount(outputs.root, run.key, name, run.activeAttempt) === 0) {
    return 0;
  }
  return last;
}

/**
 * The visits of a step in which an agent ran: a stat that names a model. A pass that only waits, such as an epic's
 * implement waiting for its tasks, names none and is no visit. A launch that ended on a provider limit and the one
 * after it are one visit.
 */
function agentVisits(own: StepStatEntity[]): number {
  const agent = own.filter((stat) => stat.model);
  const stopped = (stat: StepStatEntity): boolean =>
    stat.status === LIMIT_VISIT.status && stat.killReason === LIMIT_VISIT.killReason;
  return agent.filter((stat) => !stopped(stat)).length + (agent.length > 0 && stopped(agent[agent.length - 1]) ? 1 : 0);
}

/** The stored visits of a reviewer: its own, or the code-review visits that hold a document of its kind. */
function reviewerAttempts(name: string, stats: StepStatEntity[], documents: DocumentEntity[]): number {
  const own = stats.filter((stat) => stat.step === name);
  return own.length > 0 ? (own.at(-1)?.attempt ?? 0) : ownedVisits(stats, documents, `review_${requireReviewer(name)}`);
}

function ownedVisits(stats: StepStatEntity[], documents: DocumentEntity[], kind: string): number {
  return stats.filter(
    (stat) =>
      stat.step === 'code-review' &&
      documents.some((document) => document.stepStatId === stat.id && document.kind === kind),
  ).length;
}

/** This reviewer's chip while the code-review round is open, from this round only. Null when no round is open or the open round does not run it. */
export function reviewerRound(
  name: string,
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  outputs: OutputFiles,
  preparing = false,
  round?: OpenReviewRound,
): { attempts: number; status: string } | null {
  if (!roundOpen(run) || (round && !round.reviewers.includes(requireReviewer(name)))) {
    return null;
  }
  const last = stats.filter((stat) => stat.step === name).at(-1);
  if (last && run.stepStartedAt && last.stepStartedAt === run.stepStartedAt) {
    return { attempts: last.attempt, status: storedReviewerStatus(last, documents, requireReviewer(name)) };
  }
  const prior = reviewerAttempts(name, stats, documents);
  return roundStanding(roundLog(outputs, run, name), prior, preparing, reviewLogDecision);
}

function storedReviewerStatus(stat: StepStatEntity, documents: DocumentEntity[], reviewer: string): string {
  const decision = storedDecision(
    documents.filter((document) => document.stepStatId === stat.id),
    reviewer,
  );
  if (decision) {
    return decisionStatus(decision, 'done');
  }
  if (stat.status === 'failed' || stat.status === 'blocked') {
    return 'failed';
  }
  // A reviewer that a provider limit stopped waits for the limit to end. It did not fail.
  return stat.status === 'waiting' || stat.status === LIMIT_VISIT.status ? 'waiting' : 'done';
}

function reportAttempts(stats: StepStatEntity[], documents: DocumentEntity[]): number {
  return ownedVisits(stats, documents, 'review_report');
}

export function reviewerOutcome(text: string, fallback: string): string {
  return decisionStatus(reviewLogDecision(text), fallback);
}

/** The verdict of the angles that decided: return when one of them returned, else ok, else null. */
export function angleVerdict(documents: DocumentEntity[]): 'ok' | 'return' | null {
  const decisions = CODE_REVIEWERS.map((reviewer) => storedDecision(documents, reviewer)).filter(
    (item): item is 'ok' | 'return' => item !== null,
  );
  if (decisions.length === 0) {
    return null;
  }
  return decisions.some((item) => item === 'return') ? 'return' : 'ok';
}

export function decisionLine(body: string): string | null {
  const line = body
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('decision:') || item.startsWith('result:'))
    .pop();
  return line ?? null;
}

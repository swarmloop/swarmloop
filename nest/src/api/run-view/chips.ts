import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { liveLogFinished, liveLogView } from '../../acp/live-output';
import { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { launchCount } from '../../limits/agent-launches';
import { isReviewStep, pipelineStepOf } from '../../pipeline/pipeline-result';
import { reviewDecision } from '../../steps/code-review/code-review-record';
import { stepStatus, latest } from './flow';
import { FlowView, REVIEW_KINDS } from './run-view.types';

export function chipStatus(
  name: string,
  run: RunEntity,
  stat: StepStatEntity | undefined,
  documents: DocumentEntity[],
  log: { body: string; current: boolean } | null,
  round: { attempts: number; status: string } | null,
): string {
  if (!isReviewStep(name)) {
    return stepStatus(pipelineStepOf(name), run, stat);
  }
  const kind = `review_${name.slice('code-review-'.length)}`;
  if (stat?.step === name) {
    if (round) {
      return round.status;
    }
    if (run.currentStep === 'code-review' && run.status === 'running' && log?.current) {
      return 'running';
    }
    return storedReviewerStatus(stat, documents, kind);
  }
  const stored = latest(documents, kind) ?? '';
  const text = log?.body ?? '';
  if (run.currentStep === 'code-review' && run.status === 'running' && log?.current) {
    return 'running';
  }
  const fromLog = reviewDecision(text);
  const saved = reviewDecision(stored);
  const decision = run.currentStep === 'code-review' && fromLog ? fromLog : saved || fromLog;
  if (decision === 'ok') {
    return 'done';
  }
  if (decision === 'return') {
    return 'waiting';
  }
  if (text.trim() !== '' && text.trim() !== 'waiting for output' && text.trim() !== 'starting') {
    return 'failed';
  }
  return 'idle';
}

/** The report is written after the five angles, so it stays idle while one angle is running. */
export function reportChip(
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  root: string,
): FlowView['phases'][number]['steps'][number] {
  const log = liveLogView(root, run.key, 'code-review-report');
  const stored = (latest(documents, 'review_report') ?? '').trim();
  const verdict = angleVerdict(REVIEW_KINDS.map((kind) => latest(documents, kind) ?? '').filter((body) => body.trim() !== ''));
  const body = log.body.trim();
  const opened = body !== '' && body !== 'waiting for output';
  const writing = run.currentStep === 'code-review' && run.status === 'running' && log.current;
  const visit = stats.filter((item) => item.step === 'code-review').at(-1);
  const loopStatus = stepStatus('code-review', run, visit);
  const shown = writing ? 'running' : body === 'starting' ? 'idle' : verdict === 'ok' ? 'done' : verdict === 'return' ? 'waiting' : stored ? 'done' : opened ? 'failed' : 'idle';
  const status = run.currentStep !== 'code-review' && loopStatus === 'failed' ? loopStatus : shown;
  return {
    name: 'code-review',
    status,
    current: status === 'running',
    attempts: reportAttempts(stats, documents, writing),
  };
}

/** The badge is the visit the detail lists. A relaunch inside that visit does not raise it. A stored step with no launch record stays 0. */
export function chipAttempts(
  name: string,
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  root: string,
  log: { body: string; current: boolean } | null,
  round: { attempts: number; status: string } | null,
): number {
  if (isReviewStep(name)) {
    return reviewerAttempts(name, run, stats, documents, log, round);
  }
  const own = stats.filter((stat) => stat.step === name);
  const last = own.at(-1)?.attempt ?? 0;
  if (run.status === 'running' && run.currentStep === name) {
    return last + 1;
  }
  if (last === 0) {
    return 0;
  }
  const recorded = join(root, 'data', `${run.key}-${name}-launches.txt`);
  if (!existsSync(recorded) || launchCount(root, run.key, name) === 0) {
    return 0;
  }
  return last;
}

function reviewerAttempts(
  name: string,
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  log: { body: string; current: boolean } | null,
  round: { attempts: number; status: string } | null,
): number {
  const parentRunning = run.status === 'running' && run.currentStep === 'code-review';
  const own = stats.filter((stat) => stat.step === name);
  if (own.length > 0) {
    if (round) {
      return round.attempts;
    }
    const attempt = own.at(-1)?.attempt ?? 0;
    return parentRunning && log?.current ? attempt + 1 : attempt;
  }
  const kind = `review_${name.slice('code-review-'.length)}`;
  const owned = stats.filter(
    (stat) => stat.step === 'code-review' && documents.some((document) => document.stepStatId === stat.id && document.kind === kind),
  );
  const raw = parentRunning ? (log?.body ?? '') : '';
  const live = parentRunning && raw.trim() !== '' && raw.trim() !== 'waiting for output' && raw.trim() !== 'starting';
  return owned.length + (live ? 1 : 0);
}

/** This reviewer's chip while the code-review round is still open. Null keeps today's visit. */
export function reviewerRound(
  name: string,
  run: RunEntity,
  stat: StepStatEntity,
  documents: DocumentEntity[],
  root: string,
): { attempts: number; status: string } | null {
  if (run.status !== 'running' || run.currentStep !== 'code-review' || !run.stepStartedAt) {
    return null;
  }
  const stored = storedReviewerStatus(stat, documents, `review_${name.slice('code-review-'.length)}`);
  if (stat.stepStartedAt === run.stepStartedAt) {
    return { attempts: stat.attempt, status: stored };
  }
  const path = join(root, 'data', `${run.key}-${name}-output.txt`);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { attempts: stat.attempt, status: stored };
  }
  if (mtimeMs < Date.parse(run.stepStartedAt)) {
    return { attempts: stat.attempt, status: stored };
  }
  let body = '';
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return { attempts: stat.attempt, status: stored };
  }
  const trimmed = body.trim();
  if (trimmed === '' || trimmed === 'starting' || trimmed === 'waiting for output') {
    return { attempts: stat.attempt, status: stored };
  }
  if (!liveLogFinished(body)) {
    return { attempts: stat.attempt + 1, status: 'running' };
  }
  const decision = reviewDecision(body);
  return { attempts: stat.attempt + 1, status: decision === 'ok' ? 'done' : decision === 'return' ? 'waiting' : 'failed' };
}

function storedReviewerStatus(stat: StepStatEntity, documents: DocumentEntity[], kind: string): string {
  const body = documents
    .filter((document) => document.stepStatId === stat.id && document.kind === kind)
    .map((document) => document.body)
    .join('\n');
  const decision = reviewDecision(body);
  if (decision === 'ok') {
    return 'done';
  }
  if (decision === 'return') {
    return 'waiting';
  }
  if (stat.status === 'failed' || stat.status === 'blocked') {
    return 'failed';
  }
  return stat.status === 'waiting' ? 'waiting' : 'done';
}

function reportAttempts(stats: StepStatEntity[], documents: DocumentEntity[], writing: boolean): number {
  const saved = stats.filter(
    (stat) => stat.step === 'code-review' && documents.some((document) => document.stepStatId === stat.id && document.kind === 'review_report'),
  ).length;
  return saved + (writing ? 1 : 0);
}

export function reviewerOutcome(text: string, fallback: string): string {
  const decision = reviewDecision(text);
  if (decision === 'ok') {
    return 'done';
  }
  if (decision === 'return') {
    return 'waiting';
  }
  return fallback;
}

export function angleVerdict(bodies: string[]): 'ok' | 'return' | null {
  const decisions = bodies.map((body) => reviewDecision(body)).filter((item): item is 'ok' | 'return' => item !== null);
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

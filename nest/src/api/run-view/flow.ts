import { liveLogView } from '../../acp/live-output';
import { activeDurationMs, toDurationParts } from '../../history/active-duration';
import { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { LiveSpend } from '../../live/live.hub';
import { continuesSameStep, countedVisits, isLoopStep, isReviewStep, loopMark, pipelineStepOf, STEPS, StepName } from '../../pipeline/pipeline-result';
import { jiraIssueKey } from '../../integrations/issue-tracker/jira/jira-url';
import { answered } from '../../steps/answers';
import { items } from '../../steps/markdown-section';
import { chipStatus, chipAttempts, reportChip, reviewerRound } from './chips';
import { FlowItem, FlowView, PHASES } from './run-view.types';

export function metrics(
  run: RunEntity,
  stats: StepStatEntity[],
  live: LiveSpend,
  peaks: { cpuPeak: number; memPeak: number },
  reportMs: Map<number, number>,
): FlowView['metrics'] {
  const wall = stats.filter((stat) => !stat.step.startsWith('code-review-'));
  return {
    status: run.status,
    durationMs: activeDurationMs(toDurationParts(stats, reportMs)),
    closedStarts: wall.flatMap((stat) => (stat.stepStartedAt ? [stat.stepStartedAt] : [])),
    tokens: stats.reduce((sum, stat) => sum + stat.tokensIn + stat.tokensOut, 0) + live.tokensIn + live.tokensOut,
    usd: run.spentUsd + live.usd,
    attemptsReview: run.attemptsReview,
    attemptsQa: run.attemptsQa,
    attemptsPipeline: run.attemptsPipeline,
    cpuPeak: Math.max(
      stats.reduce((peak, stat) => Math.max(peak, stat.cpuPeak), 0),
      peaks.cpuPeak,
    ),
    memPeak: Math.max(
      stats.reduce((peak, stat) => Math.max(peak, stat.memPeak), 0),
      peaks.memPeak,
    ),
  };
}

export function phases(run: RunEntity, stats: StepStatEntity[], documents: DocumentEntity[], root: string): FlowView['phases'] {
  const latestStats = new Map<string, StepStatEntity>();
  for (const stat of stats) {
    latestStats.set(stat.step, stat);
  }
  const parentRunning = run.status === 'running' && run.currentStep === 'code-review';
  return PHASES.map((phase) => {
    const steps = phase.steps.map((name) => {
      const parent = pipelineStepOf(name);
      const own = isReviewStep(name) ? latestStats.get(name) : undefined;
      const stat = own ?? latestStats.get(parent);
      const round = own ? reviewerRound(name, run, own, documents, root) : null;
      const log = round ? null : isReviewStep(name) && (!own || parentRunning) ? liveLogView(root, run.key, name) : null;
      const status = chipStatus(name, run, stat, documents, log, round);
      return {
        name,
        status,
        current: isReviewStep(name) ? status === 'running' : parent === run.currentStep,
        attempts: chipAttempts(name, run, stats, documents, root, log, round),
      };
    });
    if (phase.phase !== 'code review') {
      return { phase: phase.phase, steps };
    }
    return { phase: phase.phase, steps: [...steps, reportChip(run, stats, documents, root)] };
  });
}

export function stepStatus(name: string, run: RunEntity, stat: StepStatEntity | undefined): string {
  if (name === 'done') {
    return run.status === 'done' ? 'done' : 'idle';
  }
  if (stat?.status === 'skipped') {
    return 'skipped';
  }
  if (name === run.currentStep) {
    return run.status === 'done' ? 'done' : run.status;
  }
  if (isLoopStep(name) && stat?.status === 'waiting') {
    return 'failed';
  }
  const current = STEPS.indexOf(run.currentStep as StepName);
  const index = STEPS.indexOf(name as StepName);
  if (index < current || stat) {
    return 'done';
  }
  return 'idle';
}

export function returns(run: RunEntity): FlowView['returns'] {
  const edges: FlowView['returns'] = [];
  if (run.attemptsReview > 0) {
    edges.push({ counter: 'review', count: run.attemptsReview, from: 'code-review', to: 'implement' });
  }
  if (run.attemptsPipeline > 0) {
    edges.push({ counter: 'pipeline', count: run.attemptsPipeline, from: 'pipeline', to: 'implement' });
  }
  return edges;
}

export function openItems(run: RunEntity, documents: DocumentEntity[], pasteUrls: string[]): FlowItem[] {
  const itemsOut: FlowItem[] = [];
  if (run.currentStep === 'research' || run.currentStep === 'plan') {
    const stored = answered(latest(documents, 'answers') ?? '');
    for (const question of items(latest(documents, 'questions') ?? '')) {
      itemsOut.push({ kind: 'question', id: question, label: question, answer: stored.get(question) ?? '' });
    }
  }
  if (run.currentStep === 'requirements') {
    const pending = pendingUrl(latest(documents, 'pending'));
    if (pending && !pasteUrls.includes(pending) && !jiraIssueKey(pending)) {
      itemsOut.push({ kind: 'paste', id: pending, label: pending, answer: '' });
    }
  }
  return itemsOut;
}

export function resumeState(run: RunEntity, open: FlowItem[], documents: DocumentEntity[]): FlowView['resume'] {
  if (run.status === 'done') {
    return 'done';
  }
  if (run.status === 'running') {
    return 'running';
  }
  if (run.status === 'blocked') {
    return didNotFit(documents) || isLoopStep(run.currentStep) ? 'ready' : 'blocked';
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

export function sentence(run: RunEntity, open: FlowItem[], documents: DocumentEntity[], stats: StepStatEntity[], maxReturns: number): string {
  if (run.status === 'blocked') {
    return didNotFit(documents)
      ? run.currentStep === 'code-review'
        ? 'This step cannot start with the remaining agent-call budget. Resume retries from stored reviews.'
        : 'This step cannot start with the remaining agent-call budget. Resume runs it anyway.'
      : isLoopStep(run.currentStep)
        ? `Automatic retries stopped after ${maxReturns} attempts. Resume starts another.`
        : 'This run is blocked. Another return is not available.';
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
    return 'This run is done.';
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
    const returned = run.attemptsReview > 0 || run.attemptsPipeline > 0;
    return returned ? 'The next continuation returns to implementation.' : 'The next continuation implements the approved plan.';
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
  const kind = run.currentStep === 'code-review' ? 'review_residual' : run.currentStep === 'pipeline' ? 'pipeline_log' : null;
  const residual = (kind ? latest(documents, kind) : null) ?? latest(documents, 'error');
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

export function latest(documents: DocumentEntity[], kind: string): string | null {
  const found = [...documents].reverse().find((document) => document.kind === kind);
  return found?.body ?? null;
}

function pendingUrl(body: string | null): string | null {
  if (!body?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { url?: unknown };
    return typeof parsed.url === 'string' && parsed.url ? parsed.url : null;
  } catch {
    return null;
  }
}

export function runName(key: string, prompt: string | null): string {
  const line = (prompt ?? '').trim().split('\n')[0]?.slice(0, 120) ?? '';
  return line || key;
}

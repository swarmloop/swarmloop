import { activeDurationMs, toDurationParts } from '../../history/active-duration';
import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import type { FlowView } from '../../contract/api';
import type { LiveUsage } from '../../contract/live';
import {
  IMPROVE_SKIPPED_NOTE,
  isReviewStep,
  PHASES as CONTRACT_PHASES,
  PHASE_STEPS,
  pipelineStepOf,
  requireReviewer,
} from '../../contract/steps';
import { readLoopDetail } from '../../history/loop-detail';
import type { LoopEventEntity } from '../../history/entities';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import { shortLine } from '../../contract/short-text';
import { stepOutput } from '../../core/attempt-output';
import { chipStatus, chipAttempts, reportChip, reviewPreparing, reviewerRound } from './chips';
import type { OpenReviewRound } from '../../steps/shared/open-review-rounds';
export { latest } from './status';
import { PHASES } from './run-view.types';

export function metrics(
  run: RunEntity,
  stats: StepStatEntity[],
  live: LiveUsage,
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
    attemptsPipeline: run.attemptsPipeline,
    attemptsChecks: run.attemptsChecks,
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

export function phases(
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  root: string,
  loops: LoopEventEntity[] = [],
  open?: OpenReviewRound,
): FlowView['phases'] {
  const latestStats = new Map<string, StepStatEntity>();
  for (const stat of stats) {
    latestStats.set(stat.step, stat);
  }
  const preparing = reviewPreparing(root, run);
  return PHASES.map((phase) => {
    const steps = phase.steps.map((name) => {
      const parent = pipelineStepOf(name);
      const own = isReviewStep(name) ? latestStats.get(name) : undefined;
      const stat = own ?? latestStats.get(parent);
      const round = isReviewStep(name) ? reviewerRound(name, run, stats, documents, root, preparing, open) : null;
      const log = isReviewStep(name) && !own && !round ? stepOutput(root, run.key, name, run.activeAttempt) : '';
      const status = chipStatus(name, run, stat, documents, round, log);
      return {
        name,
        status,
        current: isReviewStep(name) ? status === 'running' || status === 'preparing' : parent === run.currentStep,
        attempts: chipAttempts(name, run, stats, documents, root, round),
        ...(status === 'skipped' && name === 'implement-improve' ? { note: IMPROVE_SKIPPED_NOTE } : {}),
        ...(status === 'returned' ? returnNote(name, latestStats.get(parent), documents, loops) : {}),
      };
    });
    if (phase.phase !== 'code-review') {
      return { phase: phase.phase, steps };
    }
    const working = steps.filter((step) => step.current).map((step) => requireReviewer(step.name));
    return {
      phase: phase.phase,
      steps: [...steps, reportChip(run, stats, documents, root, preparing, open, working)],
    };
  });
}

const WHY_CHARS = 60;
const CHECKS_COUNTER = 'checks';

/** The latest loop event of a counter. */
function latestLoop(loops: LoopEventEntity[], counter: string): LoopEventEntity | undefined {
  return [...loops].reverse().find((loop) => loop.counter === counter);
}

/** The failed command a checks return names, when its loop event has one. */
function failedCommand(loop: LoopEventEntity | undefined): string | undefined {
  return readLoopDetail(loop?.detail).commands?.[0];
}

function whyOf(counter: string, loops: LoopEventEntity[]): { why: string } | Record<string, never> {
  const loop = latestLoop(loops, counter);
  if (!loop) return {};
  const why = counter === CHECKS_COUNTER ? failedCommand(loop) : undefined;
  const text = why ?? shortLine(loop.reason.split('\n')[0] ?? '', WHY_CHARS);
  return text ? { why: text } : {};
}

function issueCount(documents: DocumentEntity[], stat: StepStatEntity | undefined): number | null {
  const own = documents.filter(
    (document) => document.stepStatId === stat?.id && document.kind === ARTIFACTS.issues.kind,
  );
  const body = own[own.length - 1]?.body;
  if (!stat || body === undefined) return null;
  try {
    return ARTIFACTS.issues.parse(body).length;
  } catch {
    return null;
  }
}

function returnNote(
  name: string,
  stat: StepStatEntity | undefined,
  documents: DocumentEntity[],
  loops: LoopEventEntity[],
): { returnNote: string } | Record<string, never> {
  const command = name === CHECKS_COUNTER ? failedCommand(latestLoop(loops, CHECKS_COUNTER)) : undefined;
  if (command) return { returnNote: command };
  const count = issueCount(documents, stat);
  return count === null ? {} : { returnNote: `${count} notes` };
}

export function returns(run: RunEntity, loops: LoopEventEntity[] = []): FlowView['returns'] {
  const edges: FlowView['returns'] = [];
  if (run.attemptsReview > 0) {
    edges.push({
      counter: 'review',
      count: run.attemptsReview,
      from: 'code-review',
      to: 'implement',
      ...whyOf('review', loops),
    });
  }
  if (run.attemptsPipeline > 0) {
    edges.push({
      counter: 'pipeline',
      count: run.attemptsPipeline,
      from: 'pipeline',
      to: 'implement',
      ...whyOf('pipeline', loops),
    });
  }
  if (run.attemptsChecks > 0) {
    edges.push({
      counter: CHECKS_COUNTER,
      count: run.attemptsChecks,
      from: 'checks',
      to: 'implement',
      ...whyOf(CHECKS_COUNTER, loops),
    });
  }
  return edges.sort((a, b) => boardPlace(a.from) - boardPlace(b.from));
}

/** Where the phase that holds a step sits on the board; the lines nearest to implement come first. */
function boardPlace(step: string): number {
  return CONTRACT_PHASES.findIndex((phase) => PHASE_STEPS[phase].includes(step));
}

export function runName(key: string, prompt: string | null): string {
  const line = (prompt ?? '').trim().split('\n')[0]?.slice(0, 120) ?? '';
  return line || key;
}

import { activeDurationMs, toDurationParts } from '../../history/active-duration';
import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import type { CheckCommandView, FlowView } from '../../contract/api';
import type { RelaunchView } from '../../contract/relaunch';
import { returnWords } from './return-words';
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
import { knownAttempts, OutputFiles } from '../../core/attempt-output';
import { chipStatus, chipAttempts, reportChip, reviewPreparing, reviewerRound } from './chips';
import type { OpenReviewRound } from '../../steps/shared/open-review-rounds';
import { awaitsRelaunch } from './relaunch';
import { lastOutcome } from './last-outcome';
export { latest } from './status';
import { PHASES } from './run-view.types';

/** What the log holds of a run: the cost and the tokens of all its rows. */
interface LoggedUsage {
  usd: number;
  tokens: number;
}

/** The token and cost totals of a run from the log, and the peaks of its visits and of the visits open now. */
export function usageFigures(
  stats: StepStatEntity[],
  logged: LoggedUsage,
  peaks: { cpuPeak: number; memPeak: number },
): Pick<FlowView['metrics'], 'tokens' | 'usd' | 'cpuPeak' | 'memPeak'> {
  return {
    tokens: logged.tokens,
    usd: logged.usd,
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

export function metrics(
  run: RunEntity,
  stats: StepStatEntity[],
  logged: LoggedUsage,
  peaks: { cpuPeak: number; memPeak: number },
  reportMs: Map<number, number>,
): FlowView['metrics'] {
  const wall = stats.filter((stat) => !stat.step.startsWith('code-review-'));
  return {
    status: run.status,
    durationMs: activeDurationMs(toDurationParts(stats, reportMs)),
    closedStarts: wall.flatMap((stat) => (stat.stepStartedAt ? [stat.stepStartedAt] : [])),
    attemptsReview: run.attemptsReview,
    attemptsPipeline: run.attemptsPipeline,
    attemptsChecks: run.attemptsChecks,
    ...usageFigures(stats, logged, peaks),
  };
}

/**
 * A reviewer chip, or the report, of a code review the open relaunch runs again reads `again` when it has run before and
 * idle when it has not, until the review starts.
 */
function reviewChip(
  status: string,
  parentStat: StepStatEntity | undefined,
  relaunch: RelaunchView | undefined,
): string {
  const started = status === 'running' || status === 'preparing';
  if (started || !awaitsRelaunch('code-review', parentStat, relaunch)) return status;
  return status === 'idle' ? 'idle' : 'again';
}

function reportOf(
  chip: ReturnType<typeof reportChip>,
  latestStats: Map<string, StepStatEntity>,
  relaunch: RelaunchView | undefined,
  sentBack: () => string | undefined,
): ReturnType<typeof reportChip> {
  const status = reviewChip(chip.status, latestStats.get('code-review'), relaunch);
  return { ...chip, status, ...lastOutcome(status, chip.status, sentBack) };
}

export function phases(
  run: RunEntity,
  stats: StepStatEntity[],
  documents: DocumentEntity[],
  root: string,
  loops: LoopEventEntity[] = [],
  open?: OpenReviewRound,
  rows: CheckCommandView[] = [],
  relaunch?: RelaunchView,
  serverSteps: ReadonlySet<string> = new Set(),
): FlowView['phases'] {
  const latestStats = new Map<string, StepStatEntity>();
  for (const stat of stats) {
    latestStats.set(stat.step, stat);
  }
  const outputs = new OutputFiles(root, { attempts: knownAttempts(run.activeAttempt, stats) });
  const preparing = reviewPreparing(outputs, run);
  const edges = returns(run, loops, rows);
  // How a step that went back is said: its own note, else its return edge in words.
  const sentBack = (name: string) => (): string | undefined =>
    returnNote(name, latestStats.get(pipelineStepOf(name)), documents, loops, rows).returnNote ??
    edges.find((edge) => edge.from === pipelineStepOf(name))?.words;
  return PHASES.map((phase) => {
    const steps = phase.steps.map((name) => {
      const parent = pipelineStepOf(name);
      const own = isReviewStep(name) ? latestStats.get(name) : undefined;
      const stat = own ?? latestStats.get(parent);
      const round = isReviewStep(name) ? reviewerRound(name, run, stats, documents, outputs, preparing, open) : null;
      const log = isReviewStep(name) && !own && !round ? outputs.read(run.key, name, run.activeAttempt) : '';
      const chip = chipStatus(name, run, stat, documents, round, log, relaunch);
      const status = isReviewStep(name) ? reviewChip(chip, latestStats.get(parent), relaunch) : chip;
      const before = status === 'again' ? chipStatus(name, run, stat, documents, round, log) : status;
      return {
        name,
        status,
        current: isReviewStep(name) ? status === 'running' || status === 'preparing' : parent === run.currentStep,
        attempts: chipAttempts(name, run, stats, documents, outputs, round, serverSteps),
        ...(status === 'skipped' && name === 'implement-improve' ? { note: IMPROVE_SKIPPED_NOTE } : {}),
        ...(status === 'returned' ? returnNote(name, latestStats.get(parent), documents, loops, rows) : {}),
        ...lastOutcome(status, before, sentBack(name)),
      };
    });
    if (phase.phase !== 'code-review') {
      return { phase: phase.phase, steps };
    }
    const working = steps.filter((step) => step.current).map((step) => requireReviewer(step.name));
    return {
      phase: phase.phase,
      steps: [
        ...steps,
        reportOf(
          reportChip(run, stats, documents, outputs, preparing, open, working),
          latestStats,
          relaunch,
          sentBack('code-review'),
        ),
      ],
    };
  });
}

type ReturnEdge = FlowView['returns'][number];
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

/** What a counter's latest loop event says: why in short, when it happened and the return in words. */
function loopFacts(counter: string, loops: LoopEventEntity[], rows: CheckCommandView[]): Partial<ReturnEdge> {
  const loop = latestLoop(loops, counter);
  if (!loop) return {};
  const why = counter === CHECKS_COUNTER ? failedCommand(loop) : undefined;
  const text = why ?? shortLine(loop.reason.split('\n')[0] ?? '', WHY_CHARS);
  const words = returnWords(counter, loop, rows);
  return { ...(text ? { why: text } : {}), at: loop.createdAt, ...(words ? { words } : {}) };
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
  rows: CheckCommandView[],
): { returnNote: string } | Record<string, never> {
  const loop = name === CHECKS_COUNTER ? latestLoop(loops, CHECKS_COUNTER) : undefined;
  const words = loop ? returnWords(CHECKS_COUNTER, loop, rows) : undefined;
  if (words) return { returnNote: words };
  const count = issueCount(documents, stat);
  return count === null ? {} : { returnNote: `${count} notes` };
}

export function returns(
  run: RunEntity,
  loops: LoopEventEntity[] = [],
  rows: CheckCommandView[] = [],
): FlowView['returns'] {
  const edges: FlowView['returns'] = [];
  if (run.attemptsReview > 0) {
    edges.push({
      counter: 'review',
      count: run.attemptsReview,
      from: 'code-review',
      to: 'implement',
      ...loopFacts('review', loops, rows),
    });
  }
  if (run.attemptsPipeline > 0) {
    edges.push({
      counter: 'pipeline',
      count: run.attemptsPipeline,
      from: 'pipeline',
      to: 'implement',
      ...loopFacts('pipeline', loops, rows),
    });
  }
  if (run.attemptsChecks > 0) {
    edges.push({
      counter: CHECKS_COUNTER,
      count: run.attemptsChecks,
      from: 'checks',
      to: 'implement',
      ...loopFacts(CHECKS_COUNTER, loops, rows),
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

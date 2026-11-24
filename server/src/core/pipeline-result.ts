import type { PhaseName, StepName } from '../contract/steps';
import { REASON } from '../contract/run-state';
import { PHASES, PHASE_STEPS, STEPS } from '../contract/steps';

export interface PipelineResult {
  exitCode: number;
  message: string;
  /** The shared rebase action requested Resume at the same pipeline step. */
  resume?: boolean;
}

export function isStep(value: string): value is StepName {
  return (STEPS as readonly string[]).includes(value);
}

function phaseOf(step: StepName): PhaseName | null {
  for (const phase of PHASES) {
    if (PHASE_STEPS[phase].includes(step)) {
      return phase;
    }
  }
  return null;
}

/** Keep canonical order and always include planning. Omit the list to run every phase. */
export function normalizePhases(input?: readonly string[]): PhaseName[] {
  if (!input || input.length === 0) {
    return [...PHASES];
  }
  const wanted = new Set<PhaseName>();
  for (const raw of input) {
    const name = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (name === 'merge-request') {
      wanted.add('ci');
      continue;
    }
    if (!(PHASES as readonly string[]).includes(name)) {
      throw new Error(`${raw} is not a phase`);
    }
    wanted.add(name as PhaseName);
  }
  wanted.add('planning');
  return PHASES.filter((phase) => wanted.has(phase));
}

/** Status of the newest stored visit of a step, or null when it has none. */
export function lastVisitStatus(stats: { step: string; status: string }[], step: string): string | null {
  return [...stats].reverse().find((item) => item.step === step)?.status ?? null;
}

/**
 * The next step to run, or null when this pause needs a person. A run waiting on the step that just finished
 * continues only when that step's last visit is `done`: the step jumped to itself, a wait or return is `waiting`.
 */
export function continues(
  finished: StepName,
  run: { status: string; currentStep: string } | null,
  lastVisit?: string | null,
): StepName | null {
  if (!run || run.status !== 'waiting') {
    return null;
  }
  if (run.currentStep === finished && lastVisit !== 'done') {
    return null;
  }
  if (!isStep(run.currentStep) || run.currentStep === 'done') {
    return null;
  }
  return run.currentStep;
}

const LOOP_STEPS: readonly StepName[] = ['checks', 'code-review', 'pipeline'];

export function isLoopStep(step: string): boolean {
  return LOOP_STEPS.includes(step as StepName);
}

/** The code of a block that names none: the loop limit at a loop step, else a plain block. */
export function ownBlockCode(step: string): string {
  return isLoopStep(step) ? REASON.loopLimit : REASON.blocked;
}

/** Auto hops skip a looping step once it already used MAX_RETURNS visits. The current visit always finishes. */
export function autoContinues(
  finished: StepName,
  run: { status: string; currentStep: string } | null,
  nextVisits: number,
  maxReturns: number,
  lastVisit?: string | null,
): StepName | null {
  const next = continues(finished, run, lastVisit);
  if (!next || (isLoopStep(next) && nextVisits >= maxReturns)) {
    return null;
  }
  return next;
}

export function loopMark(body: string | null | undefined): number {
  const value = Number(body?.trim() ?? '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function countedVisits(stats: { id: number; step: string }[], step: string, mark: number): number {
  return stats.filter((item) => item.step === step && item.id > mark).length;
}

/** Failed visits of this step from the mark onward. The visit recorded as the mark still counts. */
export function failedLaunches(
  stats: { id: number; step: string; status: string }[],
  step: string,
  mark: number,
): number {
  const from = mark > 0 ? mark : 1;
  return stats.filter((item) => item.step === step && item.status === 'failed' && item.id >= from).length;
}

/** Launches of this step from the mark onward: the distinct attempts of its failed visits, plus the dead attempt when its visit is not stored yet. */
export function failedAttemptLaunches(
  stats: { id: number; step: string; status: string; attemptId: string | null }[],
  step: string,
  mark: number,
  deadAttempt: string,
): number {
  const from = mark > 0 ? mark : 1;
  const attempts = new Set<string>([deadAttempt]);
  for (const item of stats) {
    if (item.step === step && item.status === 'failed' && item.id >= from && item.attemptId !== null) {
      attempts.add(item.attemptId);
    }
  }
  return attempts.size;
}

export function nextStep(name: StepName, phases?: readonly PhaseName[]): StepName {
  const allowed = new Set(phases ?? PHASES);
  let index = STEPS.indexOf(name);
  while (index < STEPS.length - 1) {
    index += 1;
    const candidate = STEPS[index] ?? 'done';
    if (candidate === 'done') {
      return 'done';
    }
    const phase = phaseOf(candidate);
    if (phase && allowed.has(phase)) {
      return candidate;
    }
  }
  return 'done';
}

export function settle(
  previousStep: string,
  previousStatus: string,
  step: StepName,
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
  moveTo?: StepName,
  phases?: readonly PhaseName[],
): { currentStep: string; status: string } {
  const ahead = STEPS.indexOf(previousStep as StepName) > STEPS.indexOf(step);
  if (ahead && previousStatus !== 'running') {
    return { currentStep: previousStep, status: previousStatus };
  }
  if (moveTo) {
    return { currentStep: moveTo, status: moveTo === 'done' ? 'done' : 'waiting' };
  }
  if (outcome === 'ok') {
    const currentStep = nextStep(step, phases);
    return { currentStep, status: currentStep === 'done' ? 'done' : 'waiting' };
  }
  if (outcome === 'waiting') {
    return { currentStep: step, status: 'waiting' };
  }
  if (outcome === 'blocked') {
    return { currentStep: step, status: 'blocked' };
  }
  return { currentStep: step, status: 'failed' };
}

const TICKET = '[A-Z][A-Z0-9]+-\\d+';
const SLUG_RUN = '[a-z][a-z0-9-]{1,48}';
const SESSION = `(?:${TICKET}|[a-z][a-z0-9-]{1,40})--[1-9]\\d*`;
const PART_ID = '[a-z0-9][a-z0-9-]{0,40}';
/** The longest part id: the part of a part's key after its parent's key. */
export const PART_ID_MAX_LENGTH = 41;
const JIRA_KEY = new RegExp(`^${TICKET}$`);
const RUN_ID = new RegExp(`^${SLUG_RUN}$`);
const SESSION_KEY = new RegExp(`^${SESSION}$`);
/** `<parent key>-<part id>`: the key of a part of a ticket, slug or session run. */
const PART_KEY = new RegExp(`^(?:${TICKET}|${SLUG_RUN}|${SESSION})-${PART_ID}$`);
const PART_ID_FORM = new RegExp(`^${PART_ID}$`);

/** True when `id` is a form a part's key can carry under any parent. */
export function isPartId(id: string): boolean {
  return PART_ID_FORM.test(id);
}

/** The run key of the part `partId` of the run `parentKey`. */
export function subtaskKey(parentKey: string, partId: string): string {
  return `${parentKey}-${partId}`;
}

/** Who asks for a start: a person, a planner of some level, or the machine. A start that names nobody is a person's. */
export type StartBy = 'person' | 'planner' | 'machine';

export interface StepOptions {
  prompt?: string;
  promptFile?: string;
  path?: string;
  projects?: string[];
  phases?: PhaseName[];
  auto?: boolean;
  /** Who asks for this start. Missing means a person. */
  startBy?: StartBy;
  /** The level of the planner that asks. Set only with `startBy: 'planner'`. */
  level?: number | null;
  reviewer?: string;
  /** The errors of the answer the last visit of this step failed on. The agent is told them on this launch. */
  answerErrors?: string[];
  /** Called once the step is open and the run is `running`. The driver uses it to wake the parent of a subtask that left `blocked` or `failed`. */
  opened?: () => Promise<void>;
}

/** Keep the output already on disk when the process dies. */
/** A finished success is done. Waiting is only a real pause for a person. */
export function visitStatus(
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
): 'done' | 'failed' | 'blocked' | 'waiting' {
  return outcome === 'ok' ? 'done' : outcome;
}

/** Only the run recorded `running` on this step continues the agent process that outlived a server restart. */
export function continuesSameStep(status: string, currentStep: string, step: string): boolean {
  return status === 'running' && currentStep === step;
}

export function assertKey(key: string): void {
  if (!JIRA_KEY.test(key) && !RUN_ID.test(key) && !SESSION_KEY.test(key) && !PART_KEY.test(key)) {
    throw new Error(`${key} is not a run id`);
  }
}

/** The ticket or slug, without a later session suffix. */
export function ticketKey(key: string): string {
  return key.replace(/--\d+$/, '');
}

/** The next free session id. The first session keeps the ticket key. */
export function nextSessionKey(base: string, taken: readonly string[]): string {
  const ticket = ticketKey(base);
  const used = new Set(taken);
  if (!used.has(ticket)) {
    return ticket;
  }
  let session = 2;
  while (used.has(`${ticket}--${session}`)) {
    session += 1;
  }
  return `${ticket}--${session}`;
}

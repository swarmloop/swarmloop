export interface PipelineResult {
  exitCode: number;
  message: string;
}

export const STEPS = [
  'requirements',
  'prepare',
  'research',
  'plan',
  'plan-review',
  'branch',
  'implement',
  'implement-review',
  'code-review',
  'commit',
  'merge-request',
  'pipeline',
  'done',
] as const;

export type StepName = (typeof STEPS)[number];

export const CODE_REVIEWERS = ['requirements', 'quality', 'regressions', 'security', 'performance'] as const;

export const REVIEW_STEPS = CODE_REVIEWERS.map((name) => `code-review-${name}`);

export function isReviewStep(value: string): boolean {
  return REVIEW_STEPS.includes(value);
}

export function pipelineStepOf(value: string): string {
  return isReviewStep(value) ? 'code-review' : value;
}

export function reviewerOf(value: string): string | undefined {
  return isReviewStep(value) ? value.slice('code-review-'.length) : undefined;
}

export const PHASES = ['requirements', 'brainstorm', 'implementation', 'code-review', 'ci'] as const;

export type PhaseName = (typeof PHASES)[number];

const PHASE_STEPS: Record<PhaseName, readonly StepName[]> = {
  requirements: ['requirements'],
  brainstorm: ['prepare', 'research', 'plan', 'plan-review'],
  implementation: ['branch', 'implement', 'implement-review'],
  'code-review': ['code-review'],
  ci: ['commit', 'merge-request', 'pipeline', 'done'],
};

export function isStep(value: string): value is StepName {
  return (STEPS as readonly string[]).includes(value);
}

export function phaseOf(step: StepName): PhaseName | null {
  for (const phase of PHASES) {
    if (PHASE_STEPS[phase].includes(step)) {
      return phase;
    }
  }
  return null;
}

/** Keep canonical order and always include requirements. Omit the list to run every phase. */
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
  wanted.add('requirements');
  return PHASES.filter((phase) => wanted.has(phase));
}

/** The next step to run, or null when this pause needs a person. */
export function continues(finished: StepName, run: { status: string; currentStep: string } | null): StepName | null {
  if (!run || run.status !== 'waiting' || run.currentStep === finished) {
    return null;
  }
  if (!isStep(run.currentStep) || run.currentStep === 'done') {
    return null;
  }
  return run.currentStep;
}

const LOOP_STEPS: readonly StepName[] = ['code-review', 'pipeline'];

export function isLoopStep(step: string): boolean {
  return LOOP_STEPS.includes(step as StepName);
}

/** Auto hops skip a looping step once it already used MAX_RETURNS visits. The current visit always finishes. */
export function autoContinues(
  finished: StepName,
  run: { status: string; currentStep: string } | null,
  nextVisits: number,
  maxReturns: number,
): StepName | null {
  const next = continues(finished, run);
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

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const RUN_ID = /^[a-z][a-z0-9-]{1,48}$/;
const SESSION_KEY = /^([A-Z][A-Z0-9]+-\d+|[a-z][a-z0-9-]{1,40})--([1-9]\d*)$/;

export interface StepOptions {
  prompt?: string;
  promptFile?: string;
  path?: string;
  projects?: string[];
  phases?: PhaseName[];
  auto?: boolean;
  reviewer?: string;
}

/** Keep the output already on disk when the process dies. */
/** A finished success is done. Waiting is only a real pause for a person. */
export function visitStatus(outcome: 'ok' | 'failed' | 'blocked' | 'waiting'): 'done' | 'failed' | 'blocked' | 'waiting' {
  return outcome === 'ok' ? 'done' : outcome;
}

/** A failed or paused visit of this step may finish. A step that has not started may not. */
export function continuesSameStep(status: string, currentStep: string, step: string, lastVisit: string | null): boolean {
  if (currentStep !== step) {
    return false;
  }
  if (status === 'failed') {
    return true;
  }
  return status === 'waiting' && (lastVisit === 'waiting' || lastVisit === 'failed' || lastVisit === 'running');
}

export function diedLog(saved: string): string {
  const body = saved.trim();
  return body === '' ? 'process died\n' : `${body}\nprocess died\n`;
}

export function assertKey(key: string): void {
  if (!JIRA_KEY.test(key) && !RUN_ID.test(key) && !SESSION_KEY.test(key)) {
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

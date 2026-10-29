/** Ids match nest/src/pipeline/pipeline-result.ts PHASES. */
export const PHASES = ['requirements', 'brainstorm', 'implementation', 'code-review', 'ci'] as const;

export type PhaseName = (typeof PHASES)[number];

export const PHASE_LABEL: Record<PhaseName, string> = {
  requirements: 'requirements',
  brainstorm: 'planning',
  implementation: 'implementation',
  'code-review': 'code review',
  ci: 'ci',
};

export const REVIEW_STEPS = [
  'code-review-requirements',
  'code-review-quality',
  'code-review-regressions',
  'code-review-security',
  'code-review-performance',
] as const;

const STEP_NAMES = [
  'requirements',
  'prepare',
  'research',
  'plan',
  'plan-review',
  'branch',
  'implement',
  'implement-review',
  'code-review',
  ...REVIEW_STEPS,
  'commit',
  'merge-request',
  'pipeline',
  'done',
] as const;

const PHASE_STEPS: Record<PhaseName, readonly string[]> = {
  requirements: ['requirements'],
  brainstorm: ['prepare', 'research', 'plan', 'plan-review'],
  implementation: ['branch', 'implement', 'implement-review'],
  'code-review': REVIEW_STEPS,
  ci: ['commit', 'merge-request', 'pipeline', 'done'],
};

export function pipelineStep(step: string): string {
  return (REVIEW_STEPS as readonly string[]).includes(step) ? 'code-review' : step;
}

export function expandReviewPhases<T extends { steps: { name: string }[] }>(phases: T[]): T[] {
  return phases.map((phase) => {
    if (phase.steps.some((step) => (REVIEW_STEPS as readonly string[]).includes(step.name))) {
      return phase;
    }
    const parent = phase.steps.find((step) => step.name === 'code-review');
    if (!parent) {
      return phase;
    }
    return { ...phase, steps: REVIEW_STEPS.map((name) => ({ ...parent, name })) };
  });
}

export function markReviewFinished<T extends { steps: { name: string; status: string; current: boolean }[] }>(
  phases: T[],
  name: string,
  status: string,
): T[] {
  return phases.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) => {
      if (step.name !== name || step.status === 'done') {
        return step;
      }
      return { ...step, status, current: false };
    }),
  }));
}

export function markReviewLive<T extends { steps: { name: string; status: string; current: boolean }[] }>(phases: T[], name: string): T[] {
  return phases.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) => (step.name === name ? { ...step, status: 'running', current: true } : step)),
  }));
}

/** The report log is `code-review-report`; its chip is `code-review`. Angle logs keep their own chip names. */
export function reviewChipName(step: string): string {
  return step === 'code-review-report' ? 'code-review' : step;
}

/** A torn read can mark an open reviewer idle or failed. Done and waiting are real finishes and stay. */
export function keepOpenReviews<T extends { steps: { name: string; status: string; current: boolean }[] }>(
  phases: T[],
  open: ReadonlySet<string>,
): T[] {
  return phases.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) => {
      if (!open.has(step.name) || !reviewChip(step.name) || (step.status !== 'idle' && step.status !== 'failed')) {
        return step;
      }
      return { ...step, status: 'running', current: true };
    }),
  }));
}

function reviewChip(name: string): boolean {
  return name === 'code-review' || (REVIEW_STEPS as readonly string[]).includes(name);
}

/** Live agent files are `implement-swarmloop`; the board watches `implement`. */
export function liveLogStep(entry: string, watched: string): boolean {
  const owner = STEP_NAMES.filter((name) => entry === name || entry.startsWith(`${name}-`)).sort((left, right) => right.length - left.length)[0];
  return owner === watched;
}

export function phaseOf(step: string): PhaseName {
  const name = pipelineStep(step);
  if (name === 'code-review') {
    return 'code-review';
  }
  for (const phase of PHASES) {
    if (PHASE_STEPS[phase].includes(name)) {
      return phase;
    }
  }
  return 'requirements';
}

export function phaseLabel(id: string): string {
  return (PHASE_LABEL as Record<string, string>)[id] ?? id;
}

/** Labels for the last launch only, in PHASES order. `merge-request` is `ci`. */
export function latestPhaseLabels(launches: readonly { phases: readonly string[] }[]): string[] {
  const latest = launches.at(-1)?.phases ?? [];
  const names = new Set(latest.map((phase) => (phase === 'merge-request' ? 'ci' : phase)));
  const ordered = PHASES.filter((phase) => names.has(phase)).map((phase) => phaseLabel(phase));
  const extra: string[] = [];
  for (const phase of latest) {
    const name = phase === 'merge-request' ? 'ci' : phase;
    if ((PHASES as readonly string[]).includes(name) || extra.includes(name)) {
      continue;
    }
    extra.push(name);
  }
  return [...ordered, ...extra];
}

/**
 * Replay from `step`. The clicked phase is on and locked.
 * Earlier phases stay on and locked only when the original flow included them.
 * Later phases start from the latest selection and stay editable.
 */
export function replaySelection(
  original: readonly string[],
  latest: readonly string[],
  step: string,
): { selected: PhaseName[]; locked: PhaseName[] } {
  const known = (names: readonly string[]): PhaseName[] => PHASES.filter((phase) => names.includes(phase));
  const origin = new Set(known(original).length > 0 ? known(original) : PHASES);
  const current = new Set(known(latest).length > 0 ? known(latest) : origin);
  const clickedAt = PHASES.indexOf(phaseOf(step));
  const locked: PhaseName[] = [];
  const selected = new Set<PhaseName>();
  for (const phase of PHASES) {
    const index = PHASES.indexOf(phase);
    if (index <= clickedAt) {
      locked.push(phase);
      if (phase === 'requirements' || index === clickedAt || origin.has(phase)) {
        selected.add(phase);
      }
    } else if (current.has(phase)) {
      selected.add(phase);
    }
  }
  return { selected: PHASES.filter((phase) => selected.has(phase)), locked };
}

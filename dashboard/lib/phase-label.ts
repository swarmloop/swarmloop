import type { PhaseName } from '@contract/steps';

const PHASE_LABEL: Record<PhaseName, string> = {
  planning: 'planning',
  implementation: 'implementation',
  checks: 'checks',
  'code-review': 'code review',
  ci: 'ci',
};

/** How a phase is named on screen. A name that is no phase shows as it is. */
export function phaseLabel(id: string): string {
  return (PHASE_LABEL as Record<string, string>)[id] ?? id;
}

import { SwarmloopError } from '../../swarmloop-error';
import type { RequirementsSource } from './requirements-source';

export const names = ['agent', 'direct'] as const;

export type RequirementsVia = (typeof names)[number];

export function byName(
  value: string,
  sources: { agent: RequirementsSource; direct: RequirementsSource },
): RequirementsSource {
  const known = { agent: sources.agent, direct: sources.direct };
  if (!Object.hasOwn(known, value)) {
    throw new SwarmloopError(`REQUIREMENTS_VIA has unknown value ${value}`);
  }
  return known[value as keyof typeof known];
}

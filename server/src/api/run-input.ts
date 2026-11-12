import { BadRequestException } from '@nestjs/common';
import { CHECKOUT_NAME, storedProjects } from '../config/checkout-path';
import { assertKey, normalizePhases } from '../core/pipeline-result';
import type { PhaseName } from '../contract/steps';

/** The phases a request names, or the defaults. A bad name is a 400. */
export function phaseNames(input?: string[]): PhaseName[] {
  try {
    return normalizePhases(input);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'phases are invalid');
  }
}

/** The distinct, sorted project names a request names. A name that is not a checkout is a 400. */
function projectNames(input?: string[]): string[] {
  const names = [...new Set((input ?? []).map((name) => name.trim()).filter((name) => name.length > 0))].sort();
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
      throw new BadRequestException(`${name} is not a project`);
    }
  }
  return names;
}

/** A run id that is not valid is a 400. */
export function assertRunId(key: string): void {
  try {
    assertKey(key);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'run id is invalid');
  }
}

/** The projects a run already stores, else the ones the request names. A run with no path and no project is a 400. */
export function projectsOf(
  requested: string[] | undefined,
  stored: string | null | undefined,
  path?: string,
): string[] {
  const projects = storedProjects(stored).length > 0 ? storedProjects(stored) : projectNames(requested);
  if (!path && projects.length === 0) {
    throw new BadRequestException('projects is missing');
  }
  return projects;
}

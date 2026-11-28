import { BadRequestException } from '@nestjs/common';
import { isProjectName, storedProjects } from '../config/checkout-path';
import { repositoryPick } from '../config/repository-pick';
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

/** The distinct, sorted projects a request names: checkout names, and `owner/name` picks of remote repositories. Any other value is a 400. */
function projectNames(input?: string[]): string[] {
  const names = [...new Set((input ?? []).map((name) => name.trim()).filter((name) => name.length > 0))].sort();
  for (const name of names) {
    if (repositoryPick(name) === null && !isProjectName(name)) {
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

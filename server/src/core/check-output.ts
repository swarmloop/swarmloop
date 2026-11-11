import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SUFFIX = '-log.txt';

/** The full output of one check command of one visit of a step. A command's file is never shared or overwritten. */
export function checkOutputPath(root: string, key: string, step: string, attemptId: string, index: number): string {
  return join(root, 'data', `${key}-${step}-${attemptId}-command-${index}${SUFFIX}`);
}

/** True for a check command file of this run, so retention removes it with the run's other logs. */
export function isCheckOutputOf(name: string, key: string): boolean {
  return name.startsWith(`${key}-checks-`) && /-command-\d+-log\.txt$/.test(name);
}

/** What the command wrote, or null when no file exists. */
export function readCheckOutput(
  root: string,
  key: string,
  step: string,
  attemptId: string,
  index: number,
): string | null {
  const path = checkOutputPath(root, key, step, attemptId, index);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

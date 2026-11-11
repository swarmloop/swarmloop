import { existsSync, readFileSync } from 'fs';
import { resolve, sep } from 'path';

const SUFFIX = '-log.txt';
/** A name part holds no separator, so the file stays in `data/` whatever the caller passed. */
const SAFE_PART = /^[\w.-]*$/;

/** The full output of one check command of one visit of a step. A command's file is never shared or overwritten. */
export function checkOutputPath(root: string, key: string, step: string, attemptId: string, index: number): string {
  if (!SAFE_PART.test(key) || !SAFE_PART.test(step) || !SAFE_PART.test(attemptId)) {
    throw new Error('check output name is invalid');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('check output name is invalid');
  }
  const data = resolve(root, 'data');
  const file = resolve(data, `${key}-${step}-${attemptId}-command-${index}${SUFFIX}`);
  if (!file.startsWith(`${data}${sep}`)) {
    throw new Error('check output name is invalid');
  }
  return file;
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

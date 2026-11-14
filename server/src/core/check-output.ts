import { existsSync, readFileSync } from 'fs';
import { resolve, sep } from 'path';
import { runLogPath } from './run-logs';

const SUFFIX = '-log.txt';
/** A name part holds no separator, so the file stays in its folder whatever the caller passed. */
const SAFE_PART = /^[\w.-]*$/;

/** The full output of one check command of one visit of a step. A command's file is never shared or overwritten. */
export function checkOutputPath(root: string, key: string, step: string, attemptId: string, index: number): string {
  if (!SAFE_PART.test(step) || !SAFE_PART.test(attemptId)) {
    throw new Error('check output name is invalid');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('check output name is invalid');
  }
  return runLogPath(root, key, `${step}-${attemptId}-command-${index}`);
}

/** The file runs wrote flat in `data/` before the log folder; it is read and removed for those runs. */
function flatCheckOutputPath(root: string, key: string, step: string, attemptId: string, index: number): string {
  const data = resolve(root, 'data');
  const file = resolve(data, `${key}-${step}-${attemptId}-command-${index}${SUFFIX}`);
  if (!file.startsWith(`${data}${sep}`)) {
    throw new Error('check output name is invalid');
  }
  return file;
}

/** True for a flat check command file of this run, so retention removes it with the run's other logs. */
export function isCheckOutputOf(name: string, key: string): boolean {
  return name.startsWith(`${key}-checks-`) && /-command-\d+-log\.txt$/.test(name);
}

/** What the command wrote, in the run's log folder or, for an older run, flat in `data/`. Null when no file exists. */
export function readCheckOutput(
  root: string,
  key: string,
  step: string,
  attemptId: string,
  index: number,
): string | null {
  const path = checkOutputPath(root, key, step, attemptId, index);
  if (existsSync(path)) {
    return readFileSync(path, 'utf8');
  }
  const flat = flatCheckOutputPath(root, key, step, attemptId, index);
  return existsSync(flat) ? readFileSync(flat, 'utf8') : null;
}

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { REVIEW_STEPS, STEPS } from '../contract/steps';

/** The output file of one attempt of a step. A relaunch of the step writes another file. */
export function attemptOutputPath(root: string, key: string, step: string, attemptId: string): string {
  return join(root, 'data', `${key}-${step}-${attemptId}-output.txt`);
}

/** The output file to write for an attempt. A launch without an attempt keeps today's name. */
export function outputFileFor(root: string, key: string, step: string, attemptId: string | null): string {
  return attemptId ? attemptOutputPath(root, key, step, attemptId) : join(root, 'data', `${key}-${step}-output.txt`);
}

/** An attempt file of this step: a non-empty id between the step and the suffix, not the file of a sibling step. */
function isAttemptFile(name: string, key: string, step: string): boolean {
  const prefix = `${key}-${step}-`;
  const suffix = '-output.txt';
  if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) {
    return false;
  }
  const id = name.slice(prefix.length, name.length - suffix.length);
  return ![...STEPS, ...REVIEW_STEPS].some(
    (other) =>
      other !== step &&
      other.startsWith(`${step}-`) &&
      (id === other.slice(step.length + 1) || id.startsWith(`${other.slice(step.length + 1)}-`)),
  );
}

/** The file of one attempt, else (without an id) the newest attempt file, else the single file of a run from before attempts. */
export function stepOutputPath(root: string, key: string, step: string, attemptId: string | null): string | null {
  const own = attemptId ? attemptOutputPath(root, key, step, attemptId) : null;
  if (own && existsSync(own)) {
    return own;
  }
  const directory = join(root, 'data');
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => isAttemptFile(name, key, step))
        .map((name) => ({ path: join(directory, name), mtimeMs: modifiedAt(join(directory, name)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    : [];
  if (files.length > 0) {
    return attemptId ? null : files[0].path;
  }
  const old = outputFileFor(root, key, step, null);
  return existsSync(old) ? old : null;
}

/** What one attempt of a step wrote. Never the output of two attempts joined. */
export function stepOutput(root: string, key: string, step: string, attemptId: string | null): string {
  const path = stepOutputPath(root, key, step, attemptId);
  return path ? readFile(path) : '';
}

/** A file removed while the directory is scanned counts as the oldest. */
function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** True when the agent wrote its final result line. */
export function hasFinalResult(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('{"type":"result"'));
}

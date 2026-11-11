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

/** Every step that writes an output file. */
export const OUTPUT_STEPS: readonly string[] = [...STEPS, ...REVIEW_STEPS, 'code-review-report', 'chat'];

/** True for any output file of this run: one per attempt, or the single file of a run from before attempts. */
export function isOutputFileOf(name: string, key: string): boolean {
  return OUTPUT_STEPS.some((step) => name === `${key}-${step}-output.txt` || isAttemptFile(name, key, step));
}

/** The file of one attempt, else (without an id) the newest attempt file, else the single file of a run from before attempts. */
export function stepOutputPath(root: string, key: string, step: string, attemptId: string | null): string | null {
  const own = attemptId ? attemptOutputPath(root, key, step, attemptId) : null;
  if (own && existsSync(own)) {
    return own;
  }
  const files = attemptFiles(root, key, step);
  if (files.length > 0) {
    return attemptId ? null : join(root, 'data', files[0].name);
  }
  const old = outputFileFor(root, key, step, null);
  return existsSync(old) ? old : null;
}

function attemptFiles(root: string, key: string, step: string): { name: string; mtimeMs: number }[] {
  const directory = join(root, 'data');
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => isAttemptFile(name, key, step))
        .map((name) => ({ name, mtimeMs: modifiedAt(join(directory, name)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    : [];
}

/** The attempt ids that have an output file for this step, newest first. */
export function attemptIdsOf(root: string, key: string, step: string): string[] {
  const prefix = `${key}-${step}-`;
  return attemptFiles(root, key, step).map((file) => file.name.slice(prefix.length, -'-output.txt'.length));
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

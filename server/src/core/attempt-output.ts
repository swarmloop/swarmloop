import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { liveLogBody } from './live-output';

/** The output file of one attempt of a step. A relaunch of the step writes another file. */
export function attemptOutputPath(root: string, key: string, step: string, attemptId: string): string {
  return join(root, 'data', `${key}-${step}-${attemptId}-output.txt`);
}

/** The output file to write for an attempt. A launch without an attempt keeps today's name. */
export function outputFileFor(root: string, key: string, step: string, attemptId: string | null): string {
  return attemptId ? attemptOutputPath(root, key, step, attemptId) : join(root, 'data', `${key}-${step}-output.txt`);
}

/** What an attempt wrote: its own file first, then what the step's files of an older run hold. */
export function readAttemptOutput(root: string, key: string, step: string, attemptId: string | null): string {
  const own = attemptId ? attemptOutputPath(root, key, step, attemptId) : null;
  if (own && existsSync(own)) {
    try {
      return readFileSync(own, 'utf8');
    } catch {
      return '';
    }
  }
  return liveLogBody(root, key, step);
}

/** True when the agent wrote its final result line. */
export function hasFinalResult(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('{"type":"result"'));
}

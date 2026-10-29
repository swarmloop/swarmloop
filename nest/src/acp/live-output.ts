import { existsSync, readdirSync, readFileSync } from 'fs';
import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { REVIEW_STEPS, STEPS } from '../pipeline/pipeline-result';

/** Whole body, then rename, so a reader never sees an empty or partial log. The temp name is not another output file. */
export async function replaceLogFile(destination: string, body: string): Promise<void> {
  const temporary = `${destination}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, body);
  await rename(temporary, destination);
}

export function liveLogFinished(body: string): boolean {
  const line = lastLogLine(body);
  return line.startsWith('{"type":"result"') || line.startsWith('process exited') || line.startsWith('process killed:');
}

function lastLogLine(body: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1) ?? '';
}

/** Per-repo agents write `key-implement-swarmloop-output.txt`, not `key-implement-output.txt`. */
export function liveLogBody(root: string, key: string, step: string): string {
  return liveLogView(root, key, step).body;
}

/** One body per agent file, so a finished repo does not hide another that is still writing. */
export function liveLogBodies(root: string, key: string, step: string): string[] {
  const directory = join(root, 'data');
  if (!existsSync(directory)) {
    return [];
  }
  const exact = `${key}-${step}-output.txt`;
  const prefix = `${key}-${step}-`;
  const suffix = '-output.txt';
  return logNames(directory, exact, prefix, suffix, step)
    .map((name) => readLog(join(directory, name)))
    .filter((body) => body.length > 0);
}

/** This reviewer's own log is still writing. The five run together, so another reviewer's newer file does not hide this one. */
export function liveLogCurrent(root: string, key: string, step: string): boolean {
  return liveLogView(root, key, step).current;
}

/** Body and open flag from one directory listing, so a refresh does not read the transcript twice. */
export function liveLogView(root: string, key: string, step: string): { body: string; current: boolean } {
  const bodies = liveLogBodies(root, key, step);
  return {
    body: bodies.join('\n'),
    current: bodies.some((body) => logStillOpen(body)),
  };
}

function logStillOpen(body: string): boolean {
  const trimmed = body.trim();
  return trimmed !== '' && trimmed !== 'waiting for output' && trimmed !== 'starting' && !liveLogFinished(body);
}

function logNames(directory: string, exact: string, prefix: string, suffix: string, step: string): string[] {
  return readdirSync(directory)
    .filter((name) => logFile(name, exact, prefix, suffix, step))
    .sort();
}

function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function logFile(name: string, exact: string, prefix: string, suffix: string, step: string): boolean {
  if (name === exact) {
    return true;
  }
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return false;
  }
  const mid = name.slice(prefix.length, name.length - suffix.length);
  return ![...STEPS, ...REVIEW_STEPS].some(
    (other) =>
      other !== step &&
      other.startsWith(`${step}-`) &&
      (mid === other.slice(step.length + 1) || mid.startsWith(`${other.slice(step.length + 1)}-`)),
  );
}

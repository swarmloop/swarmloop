import { mkdirSync } from 'fs';
import { basename, resolve, sep } from 'path';
import type { SandboxMount } from './sandbox-mount';

/** Where a run's log folder is mounted, read-only, inside the agent sandbox. */
export const RUN_LOGS_PATH = '/work/logs';
const SUFFIX = '-log.txt';
/** A name part holds no separator, so a file stays in its run's log folder whatever the caller passed. */
const SAFE_PART = /^[\w.-]*$/;

function invalid(): Error {
  return new Error('run log name is invalid');
}

/** The folder that holds the whole logs of one run and nothing else. */
export function runLogDir(root: string, key: string): string {
  if (!key || !SAFE_PART.test(key)) {
    throw invalid();
  }
  return resolve(root, 'data', 'run-logs', key);
}

function ensureDir(root: string, key: string): string {
  const dir = runLogDir(root, key);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

/** The file of one whole log of a run. The run's log folder is created. */
export function runLogPath(root: string, key: string, name: string): string {
  if (!SAFE_PART.test(name)) {
    throw invalid();
  }
  const dir = ensureDir(root, key);
  const file = resolve(dir, `${name}${SUFFIX}`);
  if (!file.startsWith(`${dir}${sep}`)) {
    throw invalid();
  }
  return file;
}

/** The path an agent opens a run log at, inside the sandbox. */
export function runLogContainerPath(file: string): string {
  return `${RUN_LOGS_PATH}/${basename(file)}`;
}

/** The read-only mount of the run's log folder. The folder is created. */
export function runLogMount(root: string, key: string): SandboxMount {
  return { hostPath: ensureDir(root, key), containerPath: RUN_LOGS_PATH, readonly: true };
}

/**
 * The end of a log that is handed to an agent. When lines were left out, a first line says how many and where the whole
 * log is. `total` counts every line of the whole log.
 */
export function markedTail(
  window: readonly string[],
  total: number,
  maxLines: number,
  maxChars: number,
  file: string,
): string {
  const kept = window.slice(-maxLines).join('\n').slice(-maxChars);
  const omitted = total - kept.split('\n').length;
  return omitted <= 0
    ? kept
    : `… ${omitted} earlier lines not shown; the whole output: ${runLogContainerPath(file)}\n${kept}`;
}

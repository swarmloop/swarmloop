import { existsSync, readFileSync } from 'fs';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { liveLogBodies } from '../acp/live-output';

/** One line per process. The first line also keeps launches already visible in the log. */
export async function recordLaunch(outputFile: string, runKey: string, step: string): Promise<void> {
  const file = join(dirname(outputFile), `${runKey}-${step}-launches.txt`);
  await mkdir(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    const seen = launchesInLog(await readFile(outputFile, 'utf8').catch(() => ''));
    if (seen > 0) {
      await appendFile(file, '1\n'.repeat(seen));
    }
  }
  await appendFile(file, '1\n');
}

/** Launches of this step. The record wins. A log from before the record still counts. */
export function launchCount(root: string, key: string, step: string): number {
  const recorded = recordedLaunches(root, key, step);
  if (recorded !== null) {
    return recorded;
  }
  return liveLogBodies(root, key, step).reduce((sum, body) => sum + launchesInLog(body), 0);
}

/** A log is still being written. A finished last line is closed even when older launches remain in the record. */
export function launchOpen(root: string, key: string, step: string): boolean {
  return liveLogBodies(root, key, step).some((body) => logOpen(body));
}

function recordedLaunches(root: string, key: string, step: string): number | null {
  const file = join(root, 'data', `${key}-${step}-launches.txt`);
  if (!existsSync(file)) {
    return null;
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}

/** Finished processes, plus the one still writing when the log does not end on its exit line. */
export function launchesInLog(body: string): number {
  return endedLaunches(body) + (logOpen(body) ? 1 : 0);
}

function endedLaunches(body: string): number {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('process exited') || line.startsWith('process killed:')).length;
}

function logOpen(body: string): boolean {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1) ?? '';
  return last !== '' && last !== 'waiting for output' && last !== 'starting' && !last.startsWith('process exited') && !last.startsWith('process killed:') && !last.startsWith('{"type":"result"');
}

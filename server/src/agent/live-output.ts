import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

let nextLogTemp = 0;

/** Whole body, then rename, so a reader never sees an empty or partial log. The temp name is not another output file. */
export async function replaceLogFile(destination: string, body: string): Promise<void> {
  const temporary = `${destination}.${++nextLogTemp}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, body);
  await rename(temporary, destination);
}

export { liveLogBody, liveLogBodies, liveLogCurrent, liveLogFinished, liveLogView } from '../core/live-output';

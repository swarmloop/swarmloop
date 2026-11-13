import { containerName, stepContainers } from './sandbox-launch';

export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/**
 * Stops every container of the run: graceful first, then a kill, then a second listing to confirm.
 * 'unknown' when docker did not answer or a container is still listed.
 */
export async function stopRun(
  docker: DockerRunner,
  runKey: string,
  step: string,
  graceSeconds: number,
): Promise<'gone' | 'unknown'> {
  try {
    const found = await runContainers(docker, runKey, step);
    for (const id of found) {
      await dockerAllowingGone(docker, ['stop', '-t', String(graceSeconds), id], (graceSeconds + 30) * 1000);
    }
    for (const id of found) {
      await dockerAllowingGone(docker, ['kill', id], 30_000);
    }
    return (await runContainers(docker, runKey, step)).length === 0 ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The containers of a run by label. Containers from before the labels are found by name. Throws when docker fails. */
async function runContainers(docker: DockerRunner, runKey: string, step: string): Promise<string[]> {
  const labeled = await listed(docker, ['ps', '-q', '--filter', `label=swarmloop.run=${runKey}`]);
  const base = containerName(runKey, step);
  const fallback = await listed(docker, ['ps', '--filter', `name=${base}`, '--format', '{{.Names}}']);
  return [...new Set([...labeled, ...stepContainers(base, fallback)])];
}

async function listed(docker: DockerRunner, args: string[]): Promise<string[]> {
  const raw = await docker(args);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Runs a stop or kill. A container that is already gone is the goal, not an error. */
async function dockerAllowingGone(docker: DockerRunner, args: string[], timeoutMs: number): Promise<void> {
  try {
    await docker(args, timeoutMs);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes('No such container') && !text.includes('is not running')) {
      throw error;
    }
  }
}

/** True while a container of the attempt runs, false when none does, null when docker did not answer. */
export async function attemptRunning(docker: DockerRunner, attemptId: string): Promise<boolean | null> {
  try {
    return (await listed(docker, ['ps', '-q', '--filter', `label=swarmloop.attempt=${attemptId}`])).length > 0;
  } catch {
    return null;
  }
}

/** Kills and removes the containers of an attempt. False when docker did not answer or one is still listed. */
export async function killAttempt(docker: DockerRunner, attemptId: string): Promise<boolean> {
  try {
    for (const id of await listed(docker, ['ps', '-aq', '--filter', `label=swarmloop.attempt=${attemptId}`])) {
      await dockerAllowingGone(docker, ['rm', '-f', id], 30_000);
    }
    return (await attemptRunning(docker, attemptId)) === false;
  } catch {
    return false;
  }
}

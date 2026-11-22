import { chmod, chown, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';
import { SwarmloopError } from '../core/swarmloop-error';
import { isStateName } from './sandbox-launch';

/**
 * The folder that a container of one run gets as its /tmp. It sits in its own dot folder next to the run's
 * worktrees, on the same disk, so no run key can take its name and nothing in it reaches a repository.
 */
export function runTmpDir(root: string, key: string, unit?: string): string {
  if (!isStateName(key)) {
    throw new SwarmloopError('sandbox container name is invalid');
  }
  const base = join(root, 'worktrees', '.tmp', key);
  if (!unit) {
    return base;
  }
  if (!isStateName(unit)) {
    throw new SwarmloopError('sandbox step is invalid');
  }
  return join(base, unit);
}

/** Makes the folder ready for the sandbox user: empty when `fresh`, kept as it is otherwise. Mode 1777 like a system /tmp. */
export async function prepareRunTmp(path: string, userId: number, fresh: boolean): Promise<SandboxMount> {
  if (fresh) {
    await rm(path, { recursive: true, force: true });
  }
  await mkdir(path, { recursive: true });
  try {
    await chown(path, userId, userId);
  } catch {
    // Not allowed to give the folder away: the mode below lets the sandbox user write anyway.
  }
  await chmod(path, 0o1777);
  return { hostPath: path, containerPath: '/tmp' };
}

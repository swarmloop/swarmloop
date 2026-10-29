import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { SandboxMount } from '../sandbox/sandbox-launch';
import { SwarmloopError } from '../swarmloop-error';

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function repoNames(body: string): string[] {
  const names = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (names.length === 0) {
    throw new SwarmloopError('repos is empty');
  }
  for (const name of names) {
    if (!REPO_NAME.test(name)) {
      throw new SwarmloopError(`${name} is not a worktree`);
    }
  }
  return names;
}

export function worktreePath(root: string, key: string, name: string): string {
  const nested = join(root, 'worktrees', key, name);
  if (existsSync(nested) && statSync(nested).isDirectory()) {
    return nested;
  }
  const runDir = join(root, 'worktrees', key);
  if (name === key && existsSync(runDir) && statSync(runDir).isDirectory()) {
    return runDir;
  }
  return nested;
}

export function mountsForStep(root: string, key: string, names: string[], targetPath: string | null): SandboxMount[] {
  if (targetPath) {
    return [{ hostPath: targetPath, containerPath: '/work' }];
  }
  return worktreeMounts(root, key, names);
}

export function worktreeMounts(root: string, key: string, names: string[]): SandboxMount[] {
  return [...names].sort().map((name) => {
    const hostPath = worktreePath(root, key, name);
    if (!existsSync(hostPath) || !statSync(hostPath).isDirectory()) {
      throw new SwarmloopError(`${name} is not a worktree`);
    }
    const containerPath = hostPath === join(root, 'worktrees', key) ? '/work' : `/work/${name}`;
    return { hostPath, containerPath };
  });
}

export function perRepoMounts(mounts: SandboxMount[], names: string[]): { name: string; mounts: SandboxMount[] }[] {
  if (mounts.length === 1 && mounts[0]?.containerPath === '/work') {
    return [{ name: names[0] ?? 'work', mounts }];
  }
  return mounts.map((mount, index) => ({
    name: mount.containerPath.startsWith('/work/') ? mount.containerPath.slice('/work/'.length) : (names[index] ?? 'work'),
    mounts: [mount],
  }));
}

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';
import { SwarmloopError } from '../core/swarmloop-error';
import { ciFilesOfAnyHost } from '../integrations/code-host/code-host-rules';

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function repoNames(body: string): string[] {
  return checkedRepoNames(
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** The names when there is at least one and each is a valid repo name. */
export function checkedRepoNames(names: string[]): string[] {
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

function worktreeMounts(root: string, key: string, names: string[]): SandboxMount[] {
  return [...names].sort().map((name) => {
    const hostPath = worktreePath(root, key, name);
    if (!existsSync(hostPath) || !statSync(hostPath).isDirectory()) {
      throw new SwarmloopError(`${name} is not a worktree`);
    }
    const containerPath = hostPath === join(root, 'worktrees', key) ? '/work' : `/work/${name}`;
    return { hostPath, containerPath };
  });
}

export function hasCi(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return false;
  }
  return ciFilesOfAnyHost().some((path) => hasCiFile(dir, path));
}

function hasCiFile(dir: string, path: string): boolean {
  const star = path.lastIndexOf('/*');
  if (star === -1 || star !== path.lastIndexOf('/')) {
    return existsSync(join(dir, path));
  }
  const folder = join(dir, path.slice(0, star));
  const ending = path.slice(star + 2);
  return (
    existsSync(folder) && statSync(folder).isDirectory() && readdirSync(folder).some((name) => name.endsWith(ending))
  );
}

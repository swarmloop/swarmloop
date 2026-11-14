import { mkdirSync } from 'fs';
import { join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';

/** The `worktrees` folder of the repository root as the one mount of a container that touches no checkout. */
export function worktreesMount(root: string): SandboxMount {
  const mount = { hostPath: join(root, 'worktrees'), containerPath: '/work' };
  mkdirSync(mount.hostPath, { recursive: true });
  return mount;
}

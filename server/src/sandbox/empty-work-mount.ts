import { mkdirSync } from 'fs';
import { join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';

/**
 * The one host path of the empty `/work` folder. The mount check accepts exactly this path at `/work`, compared
 * whole and never as a prefix.
 */
export function emptyWorkPath(root: string): string {
  return join(root, 'data', 'empty-work');
}

/**
 * The one mount of a container that touches no checkout: an empty folder outside `worktrees/`, under the
 * bind-mounted data folder so the daemon path maps, and so the launch walks nothing.
 */
export function emptyWorkMount(root: string): SandboxMount {
  const mount = { hostPath: emptyWorkPath(root), containerPath: '/work' };
  mkdirSync(mount.hostPath, { recursive: true });
  return mount;
}

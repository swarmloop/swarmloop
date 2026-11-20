import { mkdirSync } from 'fs';
import { join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';

/**
 * The one mount of a container that touches no checkout: an empty folder outside `worktrees/`, under the
 * bind-mounted data folder so the daemon path maps, and so the launch walks nothing.
 */
export function emptyWorkMount(root: string): SandboxMount {
  const mount = { hostPath: join(root, 'data', 'empty-work'), containerPath: '/work' };
  mkdirSync(mount.hostPath, { recursive: true });
  return mount;
}

import { isAbsolute, resolve, sep } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import type { SandboxMount } from '../core/sandbox-mount';
import { assertInsideWork } from './allowed-path';
import type { EnvMask, ProjectLaunch } from './sandbox-types';

const WORKTREE = /^\/work(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?(?:\/\.git)?$/;
const WORK_MOUNT = /^\/work(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const BRIEF_MOUNT = '/work/brief';
const GIT_METADATA = /^\/swarmloop-git\/git-[A-Za-z0-9]+$/;
const AGENT_COMMANDS = new Set(['agent', 'claude', 'codex']);

export function assertProject(project: ProjectLaunch, command: string[], home: string): void {
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,254}$/.test(project.image) &&
    /^swarmloop-cli-[a-z]+-[0-9a-f]{12}$/.test(project.cliVolume) &&
    /^[A-Za-z0-9_./:-]+$/.test(project.path) &&
    (project.shell === undefined ? AGENT_COMMANDS.has(command[0] ?? '') : command.length === 0 && project.shell !== '');
  if (!valid) {
    throw new SwarmloopError('sandbox project image is not allowed');
  }
  for (const cache of project.caches) {
    const path = cache.containerPath;
    if (!path.startsWith('/home/sandbox/') || path.split('/').includes('..') || path.endsWith('/')) {
      throw new SwarmloopError(`cache path ${path} is not allowed`);
    }
    assertDaemonPath(cache.daemonPath, home);
  }
}

export function assertMount(mount: SandboxMount, home: string, workRoots: string[]): void {
  if (!WORKTREE.test(mount.containerPath) && !GIT_METADATA.test(mount.containerPath)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  if ((mount.containerPath.endsWith('/.git') || GIT_METADATA.test(mount.containerPath)) && !mount.readonly) {
    throw new SwarmloopError('sandbox git metadata must be read-only');
  }
  assertDaemonPath(mount.hostPath, home);
  if (!mount.volume && WORK_MOUNT.test(mount.containerPath) && mount.containerPath !== BRIEF_MOUNT) {
    try {
      assertInsideWork(mount.hostPath, workRoots);
    } catch {
      throw new SwarmloopError('sandbox mount is not allowed');
    }
  }
  if (mount.daemonPath !== undefined) {
    assertDaemonPath(mount.daemonPath, home);
  }
  sandboxMount(mount);
}

export function sandboxMount(mount: SandboxMount): string {
  const access = mount.readonly ? 'true' : 'false';
  if (mount.volume) {
    if (mount.daemonPath !== undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(mount.volume)) {
      throw new SwarmloopError('sandbox mount is not allowed');
    }
    return `type=volume,src=${mount.volume},dst=${mount.containerPath},readonly=${access}`;
  }
  return `type=bind,src=${mount.daemonPath ?? mount.hostPath},dst=${mount.containerPath},readonly=${access}`;
}

export function assertDaemonPath(path: string, home: string): void {
  if (!isAbsolute(path)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  const host = resolve(path);
  const root = resolve(home);
  const ssh = resolve(home, '.ssh');
  if (host === root || host === ssh || host.startsWith(`${ssh}${sep}`) || root.startsWith(`${host}${sep}`)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  if (host.endsWith(`${sep}docker.sock`) || host.endsWith(`${sep}.env`)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
}

export function assertMask(mask: EnvMask, mounts: SandboxMount[]): void {
  const fits = mounts.some((mount) => mask.containerFile.startsWith(`${mount.containerPath}/`));
  if (!fits || mask.containerFile.includes('..')) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
}

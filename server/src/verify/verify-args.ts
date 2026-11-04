import { homedir } from 'os';
import { SwarmloopError } from '../core/swarmloop-error';
import type { EnvMask, SandboxMount } from '../sandbox/sandbox-launch';
import {
  assertDaemonPath,
  assertMask,
  containerName,
  packageRegistries,
  SANDBOX_PIDS,
  sandboxMount,
  sandboxNetworkName,
} from '../sandbox/sandbox-launch';
import { isCachePath } from './manifest';

export const VERIFY_MEMORY = '4g';
export const VERIFY_CPUS = '2';
export const VERIFY_PIDS = SANDBOX_PIDS;
export const VERIFY_TMP = '/tmp:rw,nosuid,nodev,size=512m,mode=1777';

export type VerifyPhase = 'install' | 'verify';

export interface VerifyCache {
  /** Host directory as the Docker daemon sees it. */
  daemonPath: string;
  /** Absolute path under /home/sandbox/ inside the container. */
  containerPath: string;
}

export interface VerifyLaunch {
  runKey: string;
  phase: VerifyPhase;
  image: string;
  command: string;
  /** The worktree at /work, with its daemon path already resolved. */
  worktree: SandboxMount;
  caches: VerifyCache[];
  envMasks: EnvMask[];
  maskFile: string;
  userId: number;
}

/** The `docker run` args for one install or verify command. Only install reaches the package registries. */
export function verifyArgs(launch: VerifyLaunch, home = homedir()): string[] {
  if (launch.userId <= 0) {
    throw new SwarmloopError('sandbox user is root');
  }
  if (launch.worktree.containerPath !== '/work') {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  assertDaemonPath(launch.worktree.hostPath, home);
  if (launch.worktree.daemonPath !== undefined) {
    assertDaemonPath(launch.worktree.daemonPath, home);
  }
  for (const cache of launch.caches) {
    if (!isCachePath(cache.containerPath)) {
      throw new SwarmloopError(`cache path ${cache.containerPath} is not allowed`);
    }
    assertDaemonPath(cache.daemonPath, home);
  }
  const network = launch.phase === 'install' ? sandboxNetworkName(packageRegistries()) : null;
  const args = [
    'run',
    '--rm',
    '--name',
    containerName(launch.runKey, 'verify'),
    '--user',
    `${launch.userId}:${launch.userId}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    VERIFY_PIDS,
    '--read-only',
    '--memory',
    VERIFY_MEMORY,
    '--cpus',
    VERIFY_CPUS,
    '--tmpfs',
    VERIFY_TMP,
    '--tmpfs',
    `/home/sandbox:rw,nosuid,nodev,size=64m,uid=${launch.userId},gid=${launch.userId},mode=700`,
    '--env',
    'HOME=/home/sandbox',
    '--network',
    network ?? 'none',
  ];
  for (const cache of launch.caches) {
    args.push('--mount', `type=bind,src=${cache.daemonPath},dst=${cache.containerPath},readonly=false`);
  }
  args.push('--mount', sandboxMount(launch.worktree));
  for (const mask of launch.envMasks) {
    assertMask(mask, [launch.worktree]);
    args.push('--mount', `type=bind,src=${launch.maskFile},dst=${mask.containerFile},readonly=true`);
  }
  args.push('--workdir', '/work', launch.image, 'sh', '-c', launch.command);
  return args;
}

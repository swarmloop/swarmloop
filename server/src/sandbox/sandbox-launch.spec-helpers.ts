import type { SandboxLaunch } from './sandbox-types';

export const home = '/Users/dev';

export function launch(patch: Partial<SandboxLaunch> = {}): SandboxLaunch {
  return {
    runtime: 'cursor',
    runKey: 'PROJ-1',
    step: 'research',
    attemptId: 'attempt-1',
    mounts: [{ hostPath: '/tmp/worktrees/PROJ-1/demo', containerPath: '/work/demo' }],
    workRoots: ['/tmp/worktrees'],
    envMasks: [{ hostFile: '/tmp/worktrees/PROJ-1/demo/.env', containerFile: '/work/demo/.env' }],
    allowHosts: [],
    command: ['agent', '--print', 'hello'],
    userId: 501,
    maskFile: '/tmp/swarmloop-empty-env',
    ...(patch.project
      ? { tmp: { hostPath: `/tmp/worktrees/.tmp/PROJ-1/${patch.step ?? 'research'}`, containerPath: '/tmp' } }
      : {}),
    ...patch,
  };
}

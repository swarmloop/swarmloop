import { SwarmloopError } from '../core/swarmloop-error';
import type { VerifyLaunch } from './verify-args';
import { verifyArgs } from './verify-args';

const home = '/Users/dev';

function launch(patch: Partial<VerifyLaunch> = {}): VerifyLaunch {
  return {
    runKey: 'PROJ-1',
    phase: 'verify',
    image: 'node:22',
    command: 'npm test',
    worktree: { hostPath: '/data/worktrees/demo', containerPath: '/work', daemonPath: '/host/worktrees/demo' },
    caches: [{ daemonPath: '/host/data/verify-cache/demo/home-sandbox-.npm', containerPath: '/home/sandbox/.npm' }],
    envMasks: [{ hostFile: '/data/worktrees/demo/.env', containerFile: '/work/.env' }],
    maskFile: '/host/data/swarmloop-empty-env',
    userId: 501,
    ...patch,
  };
}

function after(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

describe('verifyArgs', () => {
  it('gives verify commands no network', () => {
    expect(after(verifyArgs(launch(), home), '--network')).toBe('none');
  });

  it('gives install the registry network only', () => {
    const args = verifyArgs(launch({ phase: 'install', command: 'npm ci' }), home);
    expect(after(args, '--network')).toBe('swarmloop-registry');
    expect(args).not.toContain('--add-host');
  });

  it('names the container so a run stop finds it', () => {
    expect(after(verifyArgs(launch(), home), '--name')).toBe('swarmloop-proj-1-verify');
  });

  it('carries the agent hardening and the verify limits', () => {
    const args = verifyArgs(launch(), home);
    expect(after(args, '--user')).toBe('501:501');
    expect(after(args, '--cap-drop')).toBe('ALL');
    expect(after(args, '--security-opt')).toBe('no-new-privileges');
    expect(after(args, '--pids-limit')).toBe('256');
    expect(args).toContain('--read-only');
    expect(after(args, '--memory')).toBe('4g');
    expect(after(args, '--cpus')).toBe('2');
    expect(args).toContain('/tmp:rw,nosuid,nodev,size=512m,mode=1777');
    expect(args).toContain('/home/sandbox:rw,nosuid,nodev,size=64m,uid=501,gid=501,mode=700');
    expect(args).toContain('HOME=/home/sandbox');
    expect(args).not.toContain('--privileged');
  });

  it('mounts the worktree, the caches and the env masks, and runs the command in a shell', () => {
    const args = verifyArgs(launch(), home);
    const text = args.join(' ');
    expect(text).toContain('type=bind,src=/host/worktrees/demo,dst=/work,readonly=false');
    expect(text).toContain(
      'type=bind,src=/host/data/verify-cache/demo/home-sandbox-.npm,dst=/home/sandbox/.npm,readonly=false',
    );
    expect(text).toContain('src=/host/data/swarmloop-empty-env,dst=/work/.env,readonly=true');
    expect(args.slice(-4)).toEqual(['node:22', 'sh', '-c', 'npm test']);
    expect(after(args, '--workdir')).toBe('/work');
  });

  it('carries no model credentials and no stdin', () => {
    const args = verifyArgs(launch(), home);
    expect(args).not.toContain('-i');
    expect(args.filter((arg) => arg === '--env')).toHaveLength(1);
  });

  it.each(['/root/.npm', '/home/sandbox', '/home/sandbox/../etc', '/work/x'])('refuses the cache path %s', (path) => {
    const caches = [{ daemonPath: '/host/cache', containerPath: path }];
    expect(() => verifyArgs(launch({ caches }), home)).toThrow(SwarmloopError);
  });

  it('refuses root, a home-directory worktree and a worktree outside /work', () => {
    expect(() => verifyArgs(launch({ userId: 0 }), home)).toThrow('sandbox user is root');
    expect(() => verifyArgs(launch({ worktree: { hostPath: home, containerPath: '/work' } }), home)).toThrow(
      'sandbox mount is not allowed',
    );
    expect(() => verifyArgs(launch({ worktree: { hostPath: '/x', containerPath: '/elsewhere' } }), home)).toThrow(
      'sandbox mount is not allowed',
    );
  });
});

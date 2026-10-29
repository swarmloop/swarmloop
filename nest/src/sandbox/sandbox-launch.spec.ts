import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopError } from '../swarmloop-error';
import { SandboxService, collectEnvMasks, parseDockerStats } from './sandbox.service';
import { agentStateDir, emptyEnvFile, modelCredential, mountsForRun, resolveDaemonPath, sandboxArgs, sandboxUserId, stepContainers, SandboxLaunch } from './sandbox-launch';

const home = '/Users/dev';

function launch(patch: Partial<SandboxLaunch> = {}): SandboxLaunch {
  return {
    runtime: 'cursor',
    runKey: 'PROJ-1',
    step: 'research',
    mounts: [{ hostPath: '/tmp/worktrees/PROJ-1/demo', containerPath: '/work/demo' }],
    envMasks: [{ hostFile: '/tmp/worktrees/PROJ-1/demo/.env', containerFile: '/work/demo/.env' }],
    allowHosts: [],
    command: ['agent', '--print', 'hello'],
    userId: 501,
    maskFile: '/tmp/swarmloop-empty-env',
    ...patch,
  };
}

describe('sandbox launch', () => {
  it('mounts only the worktree, with no egress and no host credentials', () => {
    const args = sandboxArgs(launch(), home);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('501:501');
    expect(args).toContain('/home/sandbox:rw,nosuid,nodev,size=64m,uid=501,gid=501,mode=700');
    expect(args).toContain('/tmp:rw,nosuid,nodev,size=64m,mode=1777');
    expect(args.join(' ')).toContain('type=bind,src=/tmp/worktrees/PROJ-1/demo,dst=/work/demo,readonly=false');
    expect(args.join(' ')).toContain('src=/tmp/swarmloop-empty-env,dst=/work/demo/.env,readonly=true');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('host');
    expect(args.join('\n')).not.toContain('docker.sock');
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--env');
    const imageAt = args.indexOf('swarmloop-agent-cursor');
    expect(args[imageAt + 1]).toBe('agent');
  });

  it('gives each step its own home and keeps the shell on the run directory', () => {
    expect(agentStateDir('/app', 'PROJ-12--3')).toBe('/app/data/agent-state/PROJ-12--3');
    expect(agentStateDir('/app', 'PROJ-12--3', 'code-review-security')).toBe(
      '/app/data/agent-state/PROJ-12--3/code-review-security',
    );
    expect(() => agentStateDir('/app', 'PROJ-12--3', '../security')).toThrow(SwarmloopError);
  });

  it('matches a step container and its reviewers without a longer sibling key', () => {
    const base = 'swarmloop-proj-1--3-code-review';
    expect(
      stepContainers(base, [
        base,
        `${base}-security`,
        'swarmloop-proj-1--30-code-review',
        'swarmloop-proj-1--3-implement',
      ]),
    ).toEqual([base, `${base}-security`]);
  });

  it('binds the feature home and allocates a terminal only when asked', () => {
    const args = sandboxArgs(launch({ statePath: '/tmp/agent-state/PROJ-1', tty: true, stdin: true }), home);
    expect(args.join(' ')).toContain('type=bind,src=/tmp/agent-state/PROJ-1,dst=/home/sandbox,readonly=false');
    expect(args.join(' ')).not.toContain('/home/sandbox:rw,nosuid');
    expect(args).toContain('-t');
    expect(args).toContain('-i');
    expect(() => sandboxArgs(launch({ statePath: home }), home)).toThrow(SwarmloopError);
  });

  it('mounts only the target directory for a third-party path', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-mounts-'));
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, 'alpha'));
    const target = join(root, 'target');
    mkdirSync(target);
    expect(mountsForRun(root, null).map((mount) => mount.containerPath)).toEqual(['/work/alpha', '/work/beta', '/work/target']);
    expect(mountsForRun(root, target)).toEqual([{ hostPath: target, containerPath: '/work' }]);
  });

  it('gives the daemon the host path behind a container symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-daemon-')));
    const checkouts = join(root, 'checkouts');
    const link = join(root, 'worktrees', 'run-1');
    mkdirSync(join(checkouts, 'run-1'), { recursive: true });
    mkdirSync(join(root, 'worktrees'));
    symlinkSync(join(checkouts, 'run-1'), link);
    expect(resolveDaemonPath(link, [{ destination: checkouts, source: '/Users/dev/www' }])).toBe('/Users/dev/www/run-1');
    expect(resolveDaemonPath('/tmp/worktrees/PROJ-1', [])).toBe('/tmp/worktrees/PROJ-1');
    const mask = emptyEnvFile('/app/data/agent-state/PROJ-1');
    expect(mask).toBe('/app/data/swarmloop-empty-env');
    expect(emptyEnvFile('/app/data/agent-state/PROJ-12--3/code-review-security')).toBe('/app/data/swarmloop-empty-env');
    expect(resolveDaemonPath(mask, [{ destination: '/app/data', source: '/Users/dev/www/swarmloop/data' }])).toBe(
      '/Users/dev/www/swarmloop/data/swarmloop-empty-env',
    );
  });

  it('uses the daemon path for a bind and a volume name for a shared disk', () => {
    const bind = sandboxArgs(
      launch({
        mounts: [{ hostPath: '/data/checkout', daemonPath: '/builds/group/project', containerPath: '/work' }],
        envMasks: [],
      }),
      home,
    );
    expect(bind.join(' ')).toContain('type=bind,src=/builds/group/project,dst=/work,readonly=false');
    expect(bind.join(' ')).not.toContain('src=/data/checkout');
    const volume = sandboxArgs(
      launch({
        mounts: [{ hostPath: '/data/clones/other', volume: 'swarmloop-clones', containerPath: '/work', readonly: true }],
        envMasks: [],
      }),
      home,
    );
    expect(volume.join(' ')).toContain('type=volume,src=swarmloop-clones,dst=/work,readonly=true');
    expect(() =>
      sandboxArgs(
        launch({
          mounts: [{ hostPath: '/data/clones/other', volume: 'swarmloop-clones', daemonPath: '/builds/other', containerPath: '/work' }],
        }),
        home,
      ),
    ).toThrow('sandbox mount is not allowed');
  });

  it('rejects a production host, the home directory, and root', () => {
    expect(() => sandboxArgs(launch({ allowHosts: ['api.example.com'] }), home)).toThrow('api.example.com is a production host');
    expect(() => sandboxArgs(launch({ mounts: [{ hostPath: home, containerPath: '/work' }] }), home)).toThrow(SwarmloopError);
    expect(() => sandboxArgs(launch({ userId: 0 }), home)).toThrow('sandbox user is root');
    expect(sandboxUserId(502)).toBe(502);
    expect(sandboxUserId(0, '502')).toBe(502);
    expect(sandboxUserId(0, '')).toBe(1000);
  });

  it('passes only the model key and allows that provider', () => {
    const args = sandboxArgs(
      launch({
        allowHosts: ['api2.cursor.sh'],
        env: [{ name: 'CURSOR_API_KEY', value: 'cursor-test-key' }],
        envMasks: [],
      }),
      home,
    );
    expect(args.filter((arg) => arg === '--env')).toEqual(['--env']);
    expect(args[args.indexOf('--env') + 1]).toBe('CURSOR_API_KEY=cursor-test-key');
    expect(args[args.indexOf('--network') + 1]).toBe('swarmloop-registry');
    expect(() => sandboxArgs(launch({ env: [{ name: 'GITLAB_TOKEN', value: 'x' }] }), home)).toThrow('sandbox env is not allowed');
    expect(() => modelCredential('cursor', '', '')).toThrow('CURSOR_API_KEY is missing');
    expect(() => modelCredential('claude', '', '')).toThrow('ANTHROPIC_API_KEY is missing');
  });

  it('uses an internal network only for local allowlist hosts', () => {
    const local = sandboxArgs(launch({ allowHosts: ['127.0.0.1:8080'] }), home);
    expect(local[local.indexOf('--network') + 1]).toBe('swarmloop-local');
    expect(local).toContain('host.docker.internal:host-gateway');
    const registry = sandboxArgs(launch({ allowHosts: ['registry.npmjs.org'] }), home);
    expect(registry[registry.indexOf('--network') + 1]).toBe('swarmloop-registry');
    expect(registry.join(' ')).not.toContain('--network host');
  });

  it('masks env files and leaves the example', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-env-mask-'));
    writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
    writeFileSync(join(root, '.env.example'), 'TOKEN=\n');
    mkdirSync(join(root, 'apps'));
    writeFileSync(join(root, 'apps', '.env.local'), 'TOKEN=secret\n');
    const masks = collectEnvMasks([{ hostPath: root, containerPath: '/work/demo' }]);
    expect(masks.map((mask) => mask.containerFile).sort()).toEqual(['/work/demo/.env', '/work/demo/apps/.env.local']);
  });

  it('names a missing docker daemon and a missing image', async () => {
    const sandbox = new SandboxService();
    sandbox.useDocker(async () => {
      throw new Error('down');
    });
    await expect(sandbox.assertReady('cursor')).rejects.toThrow('docker is not running');
    sandbox.useDocker(async (args) => {
      if (args[0] === 'info') {
        return 'ok';
      }
      throw new Error('missing');
    });
    await expect(sandbox.assertReady('claude')).rejects.toThrow('sandbox image is missing');
  });

  it('reads the sandbox container cpu and memory', async () => {
    expect(parseDockerStats('12.50% 80.5MiB / 7.653GiB\n')).toEqual({
      cpuPercent: 12.5,
      rssBytes: Math.round(80.5 * 1024 * 1024),
    });
    const sandbox = new SandboxService();
    sandbox.useDocker(async (args) => {
      expect(args.slice(0, 4)).toEqual(['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}']);
      return '3.25% 2KiB / 64MiB\n';
    });
    await expect(sandbox.stats('swarmloop-plan')).resolves.toEqual({ cpuPercent: 3.25, rssBytes: 2 * 1024 });
  });
});

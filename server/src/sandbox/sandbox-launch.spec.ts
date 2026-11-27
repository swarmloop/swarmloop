import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import { SwarmloopError } from '../core/swarmloop-error';
import { makeRepo, runGit, writeFiles } from '../git/git-repo.spec-helpers';
import { imageName } from './image-resolver';
import { collectEnvMasks } from './env-masks';
import { SandboxService } from './sandbox.service';
import { parseDockerStats } from './docker-stats';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { packageRegistries, setupHosts } from './sandbox-hosts';
import { home, launch } from './sandbox-launch.spec-helpers';
import {
  agentStateDir,
  emptyEnvFile,
  mountsForRun,
  resolveDaemonPath,
  sandboxArgs,
  sandboxEngine,
  sandboxUserId,
  stepContainers,
} from '../sandbox/sandbox-launch';

describe('sandbox launch', () => {
  describe('sign-in hosts', () => {
    it('lets a launch reach the hosts the CLI sign-in of its runtime needs, when it lists them', () => {
      const hosts = ['claude.ai', 'platform.claude.com', 'console.anthropic.com'];
      expect(() => sandboxArgs(launch({ runtime: 'claude', allowHosts: hosts }), home, '')).not.toThrow();
    });

    it('still refuses a host that is neither a registry nor a model or sign-in host', () => {
      expect(() => sandboxArgs(launch({ allowHosts: ['example.com'] }), home, '')).toThrow('production host');
    });
  });

  describe('machine limits', () => {
    it('gives every container a lower CPU weight than the default', () => {
      const args = sandboxArgs(launch(), home, '');
      expect(args[args.indexOf('--cpu-shares') + 1]).toBe('256');
    });

    it('gives agent, check command and setup launches the same lower CPU weight', () => {
      const project = {
        image: 'swarmloop-env-demo:0123456789ab',
        cliVolume: 'swarmloop-cli-claude-0123456789ab',
        path: '/usr/local/bin:/usr/bin:/bin',
        certFile: true,
        caches: [],
        shell: 'npm test',
      };
      const launches = [
        launch(),
        launch({ step: 'checks', runtime: 'claude', command: [], project }),
        launch({
          step: 'setup',
          runtime: 'claude',
          command: [],
          allowHosts: ['pub.dev'],
          project: { ...project, shell: 'npm ci' },
          manifestHosts: { hosts: ['pub.dev'], origins: [] },
        }),
      ];
      for (const item of launches) {
        const args = sandboxArgs(item, home, '');
        expect(args[args.indexOf('--cpu-shares') + 1]).toBe('256');
      }
    });

    it('leaves the server and dashboard services at the default CPU weight', () => {
      const root = join(__dirname, '..', '..', '..');
      for (const file of ['compose.yml', 'compose.override.yml']) {
        const services = readFileSync(join(root, file), 'utf8').split(/^services:\n/m)[1] ?? '';
        const blocks = services.split(/^(?= {2}[\w-]+:\s*$)/m);
        for (const name of ['server', 'dashboard']) {
          const block = blocks.find((item) => item.startsWith(`  ${name}:`)) ?? '';
          if (file === 'compose.yml') expect(block).not.toBe('');
          expect(block).not.toMatch(/^\s+(cpu_shares|cpus):/m);
        }
      }
    });

    describe('cores', () => {
      const project = {
        image: 'swarmloop-env-demo:0123456789ab',
        cliVolume: 'swarmloop-cli-claude-0123456789ab',
        path: '/usr/local/bin:/usr/bin:/bin',
        certFile: true,
        caches: [],
      };
      const cores = (patch: Partial<SandboxLaunch>): string | undefined => {
        const args = sandboxArgs(launch(patch), home, '');
        return args.includes('--cpuset-cpus') ? args[args.indexOf('--cpuset-cpus') + 1] : undefined;
      };
      const check = (index: number, machine: number): string | undefined =>
        cores({
          command: [],
          project: { ...project, shell: 'npm test' },
          cpuSlice: { cores: machine, places: 3, index },
        });

      it('gives the checks of 8 cores and 3 places two cores each', () => {
        expect([0, 1, 2].map((place) => check(place, 8))).toEqual(['0-1', '2-3', '4-5']);
      });

      it('gives every check one core when there are fewer cores than places', () => {
        expect([0, 1, 2].map((place) => check(place, 2))).toEqual(['0', '1', '0']);
      });

      it('gives an agent in a project image a slice of the same size', () => {
        expect(cores({ project, cpuSlice: { cores: 8, places: 3, index: 0 } })).toBe('0-1');
      });

      it('gives a check the weight of 1024 and the cores of its place, an agent and a setup 256 and a slice of the same size', () => {
        const shares = (patch: Partial<SandboxLaunch>): string => {
          const args = sandboxArgs(launch(patch), home, '');
          return args[args.indexOf('--cpu-shares') + 1] ?? '';
        };
        const checkLaunch = {
          command: [],
          project: { ...project, shell: 'npm test' },
          checkPlace: 1,
          cpuSlice: { cores: 8, places: 2, index: 1 },
        };
        const setupLaunch = {
          step: 'setup',
          command: [],
          project: { ...project, shell: 'npm ci' },
          cpuSlice: { cores: 8, places: 2, index: 0 },
        };
        const agentLaunch = { project, cpuSlice: { cores: 8, places: 2, index: 0 } };
        expect([shares(checkLaunch), cores(checkLaunch)]).toEqual(['1024', '4-7']);
        expect([shares(setupLaunch), cores(setupLaunch)]).toEqual(['256', '0-3']);
        expect([shares(agentLaunch), cores(agentLaunch)]).toEqual(['256', '0-3']);
      });

      it('gives a check, an agent and a setup with unknown cores no cores and 256', () => {
        const unknown = [
          { command: [], project: { ...project, shell: 'npm test' }, checkPlace: 1 },
          { project },
          { step: 'setup', command: [], project: { ...project, shell: 'npm ci' } },
        ];
        for (const patch of unknown) {
          const args = sandboxArgs(launch(patch), home, '');
          expect(args).not.toContain('--cpuset-cpus');
          expect(args[args.indexOf('--cpu-shares') + 1]).toBe('256');
          expect(args).toEqual(sandboxArgs(launch({ ...patch, checkPlace: undefined }), home, ''));
        }
      });

      it('leaves a container outside a project image and a container with unknown cores as they are', () => {
        expect(cores({ cpuSlice: { cores: 8, places: 3, index: 0 } })).toBeUndefined();
        expect(sandboxArgs(launch({ cpuSlice: { cores: 8, places: 3, index: 0 } }), home, '')).toEqual(
          sandboxArgs(launch(), home, ''),
        );
        expect(cores({ project })).toBeUndefined();
      });
    });

    it('caps the memory only when a cap is given', () => {
      expect(sandboxArgs(launch(), home, '')).not.toContain('--memory');
      const args = sandboxArgs(launch({ memoryCapBytes: 6 * 1024 ** 3 }), home, '');
      expect(args[args.indexOf('--memory') + 1]).toBe('6442450944b');
    });
  });

  describe('run labels', () => {
    it('labels every run container with its run, step and attempt', () => {
      const labels = (args: string[]) => args.filter((arg, index) => args[index - 1] === '--label');
      const project = {
        image: 'swarmloop-env-demo:0123456789ab',
        cliVolume: 'swarmloop-cli-claude-0123456789ab',
        path: '/usr/local/bin:/usr/bin:/bin',
        certFile: true,
        caches: [],
      };
      const cases = [
        launch(),
        launch({ step: 'setup', runtime: 'claude', command: [], project: { ...project, shell: 'npm ci' } }),
        launch({ step: 'checks', runtime: 'claude', command: [], project: { ...project, shell: 'npm test' } }),
        launch({ step: 'code-review-security' }),
        launch({ step: 'report' }),
      ];
      for (const given of cases) {
        expect(labels(sandboxArgs(given, home, ''))).toEqual([
          'swarmloop.run=PROJ-1',
          `swarmloop.step=${given.step}`,
          `swarmloop.attempt=${given.attemptId}`,
        ]);
      }
    });

    it('labels a container whose result the server cannot read after a restart, and no other', () => {
      const labels = (args: string[]) => args.filter((arg, index) => args[index - 1] === '--label');
      expect(labels(sandboxArgs(launch({ resultLost: true }), home, ''))).toContain('swarmloop.result=lost');
      expect(labels(sandboxArgs(launch(), home, ''))).not.toContain('swarmloop.result=lost');
    });
  });

  describe('container runtime', () => {
    it('uses the configured runtime, such as gVisor, and the default without one', () => {
      const given = launch({ allowHosts: [] });
      expect(sandboxArgs(given, home, 'runsc').slice(0, 4)).toEqual(['run', '--rm', '--runtime', 'runsc']);
      expect(sandboxArgs(given, home, '')).not.toContain('--runtime');
    });

    it('refuses a value that is not a runtime name', () => {
      expect(() => sandboxEngine('runsc --privileged')).toThrow(SwarmloopError);
      expect(sandboxEngine(' runsc ')).toBe('runsc');
    });
  });

  describe('behind the egress proxy', () => {
    it('joins the internal network at its address and gets the proxy settings', () => {
      const args = sandboxArgs(launch({ allowHosts: ['*.cursor.sh'], egress: { ip: '198.18.3.3' } }), home);
      const text = args.join(' ');
      expect(text).toContain('--network swarmloop-sandbox --ip 198.18.3.3 --dns 198.18.0.2');
      expect(text).toContain('HTTPS_PROXY=http://198.18.0.2:3128');
      expect(text).not.toContain('swarmloop-registry');
    });

    it('accepts the proxy base URL only behind the proxy and only with its exact value', () => {
      const env = [
        { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-placeholder' },
        { name: 'ANTHROPIC_BASE_URL', value: 'http://198.18.0.2:3129' },
      ];
      const behind = launch({ runtime: 'claude', command: ['claude'], allowHosts: ['api.anthropic.com'], env });
      expect(sandboxArgs({ ...behind, egress: { ip: '198.18.3.3' } }, home).join(' ')).toContain(
        'ANTHROPIC_BASE_URL=http://198.18.0.2:3129',
      );
      expect(() => sandboxArgs(behind, home)).toThrow(SwarmloopError);
      const elsewhere = [env[0], { name: 'ANTHROPIC_BASE_URL', value: 'https://evil.example' }];
      expect(() => sandboxArgs({ ...behind, env: elsewhere, egress: { ip: '198.18.3.3' } }, home)).toThrow(
        SwarmloopError,
      );
    });

    it('passes a name in unsetEnv empty and refuses a name that is not an env name', () => {
      const claude = launch({ runtime: 'claude', command: ['claude'] });
      const args = sandboxArgs({ ...claude, unsetEnv: ['CLAUDE_CODE_EFFORT_LEVEL'] }, home, '');
      expect(args[args.indexOf('CLAUDE_CODE_EFFORT_LEVEL=') - 1]).toBe('--env');
      expect(sandboxArgs(claude, home, '').join(' ')).not.toContain('CLAUDE_CODE_EFFORT_LEVEL');
      expect(() => sandboxArgs({ ...claude, unsetEnv: ['x=1'] }, home, '')).toThrow('sandbox env is not allowed');
    });

    it('refuses an address outside the sandbox range', () => {
      expect(() => sandboxArgs(launch({ allowHosts: ['*.cursor.sh'], egress: { ip: '198.18.0.2' } }), home)).toThrow(
        SwarmloopError,
      );
    });

    it('matches a vendor host against its wildcard and nothing else', () => {
      expect(() => sandboxArgs(launch({ allowHosts: ['api2.cursor.sh'] }), home)).not.toThrow();
      expect(() => sandboxArgs(launch({ allowHosts: ['cursor.sh.evil.com'] }), home)).toThrow(SwarmloopError);
    });
  });

  it('refuses a /tmp mount on a launch that runs no project command', () => {
    const tmp = { hostPath: '/tmp/worktrees/.tmp/PROJ-1/research', containerPath: '/tmp' };
    expect(() => sandboxArgs({ ...launch(), tmp }, home)).toThrow('sandbox /tmp is not allowed');
  });

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
    const imageAt = args.indexOf(imageName('agent-cursor'));
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

  it('binds the feature home and attaches stdin when asked', () => {
    const args = sandboxArgs(launch({ statePath: '/tmp/agent-state/PROJ-1', stdin: true }), home);
    expect(args.join(' ')).toContain('type=bind,src=/tmp/agent-state/PROJ-1,dst=/home/sandbox,readonly=false');
    expect(args.join(' ')).not.toContain('/home/sandbox:rw,nosuid');
    expect(args).toContain('-i');
    expect(() => sandboxArgs(launch({ statePath: home }), home)).toThrow(SwarmloopError);
  });

  it('mounts only the target directory for a third-party path', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-mounts-'));
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, 'alpha'));
    const target = join(root, 'target');
    mkdirSync(target);
    expect(mountsForRun(root, null).map((mount) => mount.containerPath)).toEqual([
      '/work/alpha',
      '/work/beta',
      '/work/target',
    ]);
    expect(mountsForRun(root, target)).toEqual([{ hostPath: target, containerPath: '/work' }]);
  });

  it('gives the daemon the host path behind a container symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-daemon-')));
    const checkouts = join(root, 'checkouts');
    const link = join(root, 'worktrees', 'run-1');
    mkdirSync(join(checkouts, 'run-1'), { recursive: true });
    mkdirSync(join(root, 'worktrees'));
    symlinkSync(join(checkouts, 'run-1'), link);
    expect(resolveDaemonPath(link, [{ destination: checkouts, source: '/Users/dev/www' }])).toBe(
      '/Users/dev/www/run-1',
    );
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
        workRoots: ['/data/checkout'],
        envMasks: [],
      }),
      home,
    );
    expect(bind.join(' ')).toContain('type=bind,src=/builds/group/project,dst=/work,readonly=false');
    expect(bind.join(' ')).not.toContain('src=/data/checkout');
    const volume = sandboxArgs(
      launch({
        mounts: [
          { hostPath: '/data/clones/other', volume: 'swarmloop-clones', containerPath: '/work', readonly: true },
        ],
        envMasks: [],
      }),
      home,
    );
    expect(volume.join(' ')).toContain('type=volume,src=swarmloop-clones,dst=/work,readonly=true');
    expect(() =>
      sandboxArgs(
        launch({
          mounts: [
            {
              hostPath: '/data/clones/other',
              volume: 'swarmloop-clones',
              daemonPath: '/builds/other',
              containerPath: '/work',
            },
          ],
        }),
        home,
      ),
    ).toThrow('sandbox mount is not allowed');
  });

  describe('volume subpath mounts', () => {
    const subpathLaunch = (patch: Record<string, unknown>) =>
      launch({
        mounts: [
          {
            hostPath: '/tmp/worktrees/r1/demo',
            volume: 'swarmloop-worktrees',
            volumeSubpath: 'r1/demo',
            containerPath: '/work/demo',
            ...patch,
          },
        ],
        envMasks: [],
      });

    it('mounts the folder of a volume by its subpath, read-write or read-only', () => {
      const write = sandboxArgs(subpathLaunch({}), home).filter((arg) => arg.includes('dst=/work/demo'));
      expect(write).toEqual([
        'type=volume,src=swarmloop-worktrees,volume-subpath=r1/demo,dst=/work/demo,readonly=false',
      ]);
      const read = sandboxArgs(subpathLaunch({ readonly: true }), home).filter((arg) => arg.includes('dst=/work/demo'));
      expect(read).toEqual(['type=volume,src=swarmloop-worktrees,volume-subpath=r1/demo,dst=/work/demo,readonly=true']);
    });

    it('mounts the whole volume without a subpath argument', () => {
      const whole = subpathLaunch({ hostPath: '/tmp/worktrees', volumeSubpath: '', containerPath: '/work' });
      const mounts = sandboxArgs(whole, home).filter((arg) => arg.includes('dst=/work,'));
      expect(mounts).toEqual(['type=volume,src=swarmloop-worktrees,dst=/work,readonly=false']);
    });

    it.each(['../x', 'r1/../x', '/r1', 'r1,x', 'r1 x'])('refuses the subpath %s', (volumeSubpath) => {
      expect(() => sandboxArgs(subpathLaunch({ volumeSubpath }), home)).toThrow('sandbox mount is not allowed');
    });

    it('refuses a subpath mount of a folder outside the work roots', () => {
      expect(() => sandboxArgs(subpathLaunch({ hostPath: '/srv/other' }), home)).toThrow(
        'sandbox mount is not allowed',
      );
    });
  });

  describe('work mounts', () => {
    it('refuses a /work mount from outside the allowed roots, and lets the brief and worktrees through', () => {
      const outside = launch({ mounts: [{ hostPath: '/srv/other-repo', containerPath: '/work' }], envMasks: [] });
      expect(() => sandboxArgs(outside, home)).toThrow('sandbox mount is not allowed');
      const named = launch({ mounts: [{ hostPath: '/srv/other-repo', containerPath: '/work/other' }], envMasks: [] });
      expect(() => sandboxArgs(named, home)).toThrow('sandbox mount is not allowed');
      const brief = launch({
        mounts: [
          { hostPath: '/tmp/worktrees/PROJ-1/demo', containerPath: '/work/demo' },
          { hostPath: '/data/briefs/PROJ-1', containerPath: '/work/brief', readonly: true },
        ],
        envMasks: [],
      });
      expect(() => sandboxArgs(brief, home)).not.toThrow();
    });

    it('lets exactly the empty work folder through at /work', () => {
      const emptyWork = '/app/data/empty-work';
      const mount = (hostPath: string, containerPath: string, daemonPath?: string) =>
        launch({ emptyWork, mounts: [{ hostPath, containerPath, daemonPath }], envMasks: [] });
      const plain = sandboxArgs(mount(emptyWork, '/work'), home);
      expect(plain.join(' ')).toContain('dst=/work,');
      const mapped = sandboxArgs(mount(emptyWork, '/work', '/Users/dev/www/swarmloop/data/empty-work'), home);
      expect(mapped.join(' ')).toContain('src=/Users/dev/www/swarmloop/data/empty-work,dst=/work,');
      expect(() => sandboxArgs(mount(emptyWork, '/work/demo'), home)).toThrow('sandbox mount is not allowed');
      expect(() => sandboxArgs(mount(`${emptyWork}/sub`, '/work'), home)).toThrow('sandbox mount is not allowed');
      expect(() => sandboxArgs(mount(`${emptyWork}-2`, '/work'), home)).toThrow('sandbox mount is not allowed');
    });

    it('lets the read-only attachments folder of a run through and refuses it writable', () => {
      const files = (readonly: boolean) =>
        launch({
          mounts: [{ hostPath: '/data/runs/PROJ-1/attachments', containerPath: '/work/brief/attachments', readonly }],
          envMasks: [],
        });
      expect(sandboxArgs(files(true), home).join(' ')).toContain('dst=/work/brief/attachments,readonly=true');
      expect(() => sandboxArgs(files(false), home)).toThrow('sandbox mount is not allowed');
    });

    it('refuses a symlink that leaves the allowed roots', () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-link-')));
      mkdirSync(join(base, 'repo'));
      mkdirSync(join(base, 'secret'));
      symlinkSync(join(base, 'secret'), join(base, 'repo', 'escape'));
      const mount = (hostPath: string) =>
        launch({ workRoots: [join(base, 'repo')], mounts: [{ hostPath, containerPath: '/work' }], envMasks: [] });
      expect(() => sandboxArgs(mount(join(base, 'repo')), home)).not.toThrow();
      expect(() => sandboxArgs(mount(join(base, 'repo', 'escape')), home)).toThrow('sandbox mount is not allowed');
    });

    it('has two sandboxArgs callers and both pass workRoots', () => {
      const files = readdirSync(join(__dirname, '..'), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
        .map((file) => join(__dirname, '..', file));
      const callers = files.filter(
        (file) => /\bsandboxArgs\(/.test(readFileSync(file, 'utf8')) && !file.endsWith('sandbox-launch.ts'),
      );
      expect(callers.map((file) => basename(file)).sort()).toEqual(['sandbox.service.ts']);
      for (const file of callers) {
        expect(readFileSync(file, 'utf8')).toContain('workRoots');
      }
    });
  });

  it('gives the release downloads of native packages to the setup only', () => {
    expect(setupHosts()).toEqual(expect.arrayContaining(['github.com', 'release-assets.githubusercontent.com']));
    expect(packageRegistries()).not.toContain('github.com');
    expect(() => sandboxArgs(launch({ allowHosts: setupHosts() }), home)).not.toThrow();
  });

  it('rejects a production host, the home directory, and root', () => {
    expect(() => sandboxArgs(launch({ allowHosts: ['api.example.com'] }), home)).toThrow(
      'api.example.com is a production host',
    );
    expect(() => sandboxArgs(launch({ mounts: [{ hostPath: home, containerPath: '/work' }] }), home)).toThrow(
      SwarmloopError,
    );
    expect(() => sandboxArgs(launch({ userId: 0 }), home)).toThrow('sandbox user is root');
    expect(sandboxUserId(502)).toBe(502);
    expect(sandboxUserId(0, '502')).toBe(502);
    expect(sandboxUserId(0, '')).toBe(1000);
    expect(sandboxUserId(0, 'abc')).toBe(1000);
    expect(sandboxUserId(0, '0')).toBe(1000);
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
    expect(() => sandboxArgs(launch({ env: [{ name: 'GITLAB_TOKEN', value: 'x' }] }), home)).toThrow(
      'sandbox env is not allowed',
    );
    const both = { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token' };
    const claude = sandboxArgs(launch({ env: [both], envMasks: [] }), home);
    expect(claude.filter((arg) => arg === '--env')).toEqual(['--env']);
    expect(claude[claude.indexOf('--env') + 1]).toBe('CLAUDE_CODE_OAUTH_TOKEN=token');
    expect(claude.join(' ')).not.toContain('ANTHROPIC_API_KEY');
  });

  it('uses an internal network only for local allowlist hosts', () => {
    const local = sandboxArgs(launch({ allowHosts: ['127.0.0.1:8080'] }), home);
    expect(local[local.indexOf('--network') + 1]).toBe('swarmloop-local');
    expect(local).toContain('host.docker.internal:host-gateway');
    const registry = sandboxArgs(launch({ allowHosts: ['registry.npmjs.org'] }), home);
    expect(registry[registry.indexOf('--network') + 1]).toBe('swarmloop-registry');
    expect(registry.join(' ')).not.toContain('--network host');
  });

  it('accepts the Packagist hosts as registries', () => {
    const args = sandboxArgs(launch({ allowHosts: ['repo.packagist.org', 'packagist.org'] }), home);
    expect(args[args.indexOf('--network') + 1]).toBe('swarmloop-registry');
  });

  it('masks env files and leaves the example', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-env-mask-'));
    writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
    writeFileSync(join(root, '.env.example'), 'TOKEN=\n');
    mkdirSync(join(root, 'apps'));
    writeFileSync(join(root, 'apps', '.env.local'), 'TOKEN=secret\n');
    const masks = await collectEnvMasks([{ hostPath: root, containerPath: '/work/demo' }]);
    expect(masks.map((mask) => mask.containerFile).sort()).toEqual(['/work/demo/.env', '/work/demo/apps/.env.local']);
  });

  describe('in a git checkout', () => {
    const masked = async (root: string) =>
      (await collectEnvMasks([{ hostPath: root, containerPath: '/w' }])).map((mask) => mask.containerFile).sort();

    it('leaves a tracked env file and masks an untracked one whatever its suffix', async () => {
      const root = makeRepo({ '.env.sample': 'TOKEN=\n' });
      writeFiles(root, { '.env.local': 's\n', '.env.example': 's\n', '.env': 's\n' });
      expect(await masked(root)).toEqual(['/w/.env', '/w/.env.example', '/w/.env.local']);
    });

    it.each(['node_modules', '.venv'])('does not walk an ignored %s', async (folder) => {
      const root = makeRepo({ '.gitignore': `${folder}/\n` });
      writeFiles(root, { [`${folder}/pkg/.env`]: 's\n', '.env': 's\n' });
      expect(await masked(root)).toEqual(['/w/.env']);
    });

    it('walks a node_modules that is not ignored like any folder', async () => {
      const root = makeRepo();
      writeFiles(root, { 'node_modules/pkg/.env': 's\n' });
      expect(await masked(root)).toEqual(['/w/node_modules/pkg/.env']);
    });

    it('treats a worktree, whose .git is a file, as a checkout', async () => {
      const root = makeRepo({ '.env.sample': 'x\n' });
      const tree = join(mkdtempSync(join(tmpdir(), 'swarmloop-env-tree-')), 'wt');
      runGit(root, ['worktree', 'add', '-q', '-b', 'side', tree]);
      writeFiles(tree, { '.env.local': 's\n' });
      expect(await masked(tree)).toEqual(['/w/.env.local']);
    });
  });

  it('does not scan Git metadata or treat file mounts as directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-file-mount-'));
    const pointer = join(root, 'worktree-link');
    writeFileSync(pointer, 'gitdir: /swarmloop-git/git-abcdef\n');
    writeFileSync(join(root, '.env'), 'not-a-project-secret\n');
    expect(
      await collectEnvMasks([
        { hostPath: root, containerPath: '/swarmloop-git/git-abcdef' },
        { hostPath: pointer, containerPath: '/work/app/.git' },
        { hostPath: pointer, containerPath: '/work/file' },
      ]),
    ).toEqual([]);
  });

  it('names a missing docker daemon and a missing image', async () => {
    const sandbox = new SandboxService();
    sandbox.useDocker(async () => {
      throw new Error('down');
    });
    await expect(sandbox.assertReady('cursor')).rejects.toMatchObject({
      code: ERROR_CODES.DOCKER_UNAVAILABLE,
      message: 'docker is not running',
    });
    sandbox.useDocker(async (args) => {
      if (args[0] === 'info') {
        return 'ok';
      }
      throw new Error('missing');
    });
    await expect(sandbox.assertReady('claude')).rejects.toMatchObject({
      code: ERROR_CODES.IMAGE_MISSING,
      message: expect.stringContaining(`image ${imageName('agent-claude')} is missing`),
    });
  });

  it('tells whether docker answers, running only info', async () => {
    const sandbox = new SandboxService();
    const calls: string[][] = [];
    sandbox.useDocker(async (args) => {
      calls.push(args);
      return 'ok';
    });
    await expect(sandbox.dockerAnswers()).resolves.toBe(true);
    sandbox.useDocker(async (args) => {
      calls.push(args);
      throw new Error('down');
    });
    await expect(sandbox.dockerAnswers()).resolves.toBe(false);
    expect(calls).toEqual([['info'], ['info']]);
  });

  it('reads the sandbox container cpu and memory', async () => {
    expect(parseDockerStats('12.50% 80.5MiB / 7.653GiB\n')).toEqual({
      cpuPercent: 12.5,
      rssBytes: Math.round(80.5 * 1024 * 1024),
    });
    const sandbox = new SandboxService();
    sandbox.useDocker(async (args) => {
      expect(args).toEqual(['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}']);
      return 'swarmloop-plan 3.25% 2KiB / 64MiB\n';
    });
    await expect(sandbox.stats('swarmloop-plan')).resolves.toEqual({ cpuPercent: 3.25, rssBytes: 2 * 1024 });
  });
});

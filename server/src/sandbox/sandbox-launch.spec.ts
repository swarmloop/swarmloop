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
import { hostRefusal, packageRegistries, setupHosts } from './sandbox-hosts';
import {
  agentStateDir,
  emptyEnvFile,
  modelCredential,
  mountsForRun,
  resolveDaemonPath,
  KEEP_PATH,
  sandboxArgs,
  sandboxEngine,
  sandboxUserId,
  stepContainers,
} from '../sandbox/sandbox-launch';

const home = '/Users/dev';

function launch(patch: Partial<SandboxLaunch> = {}): SandboxLaunch {
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
    ...patch,
  };
}

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
      expect(args[args.indexOf('--cpu-shares') + 1]).toBe('512');
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
        launch({ step: 'chat' }),
        launch({ step: 'shell', attemptId: '', stdin: true, tty: true }),
      ];
      for (const given of cases) {
        expect(labels(sandboxArgs(given, home, ''))).toEqual([
          'swarmloop.run=PROJ-1',
          `swarmloop.step=${given.step}`,
          `swarmloop.attempt=${given.attemptId}`,
        ]);
      }
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

  describe('in the project image', () => {
    const project = {
      image: 'swarmloop-env-demo:0123456789ab',
      cliVolume: 'swarmloop-cli-claude-0123456789ab',
      path: '/usr/local/bin:/usr/bin:/bin',
      certFile: true,
      caches: [{ daemonPath: '/Users/dev/swarmloop/data/env-cache/demo/npm', containerPath: '/home/sandbox/.npm' }],
    };
    const command = ['claude', '--print', 'hello'];

    it('mounts portable Git metadata read-only and trusts only its repository path', () => {
      const metadata = { hostPath: '/tmp/git-copy', containerPath: '/work/demo/.git', readonly: true };
      const given = launch({ runtime: 'claude', command, project });
      given.mounts.push(metadata);
      const text = sandboxArgs(given, home).join(' ');
      expect(text).toContain('dst=/work/demo/.git,readonly=true');
      expect(text).toContain('GIT_CONFIG_VALUE_0=/work/demo');
      expect(text).toContain('GIT_OPTIONAL_LOCKS=0');
      metadata.readonly = false;
      expect(() => sandboxArgs(given, home)).toThrow('git metadata must be read-only');
    });

    it('runs the CLI from the volume as the entrypoint of the project image', () => {
      const args = sandboxArgs(launch({ runtime: 'claude', command, project }), home);
      const text = args.join(' ');
      expect(text).toContain('type=volume,src=swarmloop-cli-claude-0123456789ab,dst=/opt/swarmloop,readonly=true');
      const image = args.indexOf('swarmloop-env-demo:0123456789ab');
      expect(args.slice(image - 2, image + 6)).toEqual([
        '--entrypoint',
        'sh',
        'swarmloop-env-demo:0123456789ab',
        '-c',
        KEEP_PATH,
        'sh',
        '/opt/swarmloop/bin/claude',
        '--print',
      ]);
      expect(text).not.toContain(imageName('agent-claude'));
      expect(text).toContain('PATH=/opt/swarmloop/bin:/usr/local/bin:/usr/bin:/bin');
      expect(text).toContain('HOME=/home/sandbox');
      expect(text).toContain('NODE_EXTRA_CA_CERTS=/opt/swarmloop/certs/ca-certificates.crt');
      expect(text).toContain('SSL_CERT_FILE=/opt/swarmloop/certs/ca-certificates.crt');
      expect(text).toContain('type=bind,src=/Users/dev/swarmloop/data/env-cache/demo/npm,dst=/home/sandbox/.npm');
    });

    it('gives tests an executable /tmp and keeps the same hardening', () => {
      const args = sandboxArgs(launch({ runtime: 'claude', command, project }), home);
      expect(args).toContain('/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777');
      expect(args[args.indexOf('--pids-limit') + 1]).toBe('1024');
      expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', 'no-new-privileges', '--read-only']));
      expect(args[args.indexOf('--user') + 1]).toBe('501:501');
    });

    it('leaves the image CA bundle alone when it has one', () => {
      const args = sandboxArgs(launch({ runtime: 'claude', command, project: { ...project, certFile: false } }), home);
      expect(args.join(' ')).not.toContain('SSL_CERT_FILE');
      expect(args.join(' ')).toContain('NODE_EXTRA_CA_CERTS');
    });

    it.each([
      ['a strange image', { image: 'x; rm -rf /' }],
      ['a foreign volume', { cliVolume: 'my-volume' }],
      ['a cache outside the home', { caches: [{ daemonPath: '/Users/dev/c', containerPath: '/etc/x' }] }],
      [
        'a cache from the ssh folder',
        { caches: [{ daemonPath: '/Users/dev/.ssh', containerPath: '/home/sandbox/.npm' }] },
      ],
    ])('refuses %s', (_name, patch) => {
      expect(() =>
        sandboxArgs(launch({ runtime: 'claude', command, project: { ...project, ...patch } }), home),
      ).toThrow(SwarmloopError);
    });

    it('runs a setup command with sh and no agent command', () => {
      const args = sandboxArgs(
        launch({ runtime: 'claude', command: [], project: { ...project, shell: 'npm ci' } }),
        home,
      );
      expect(args.slice(-5)).toEqual(['--entrypoint', 'sh', 'swarmloop-env-demo:0123456789ab', '-c', 'npm ci']);
      expect(() =>
        sandboxArgs(launch({ runtime: 'claude', command, project: { ...project, shell: 'npm ci' } }), home),
      ).toThrow(SwarmloopError);
    });

    it('refuses a command that is not an agent CLI', () => {
      expect(() => sandboxArgs(launch({ command: ['sh', '-c', 'x'], project }), home)).toThrow(SwarmloopError);
    });

    it('keeps the agent image and the small /tmp without a project', () => {
      const args = sandboxArgs(launch(), home);
      expect(args).toContain(imageName('agent-cursor'));
      expect(args).toContain('/tmp:rw,nosuid,nodev,size=64m,mode=1777');
      expect(args.join(' ')).not.toContain('/opt/swarmloop');
    });
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
      expect(callers.map((file) => basename(file)).sort()).toEqual(['sandbox.service.ts', 'shell.ts']);
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

  describe('manifest hosts', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const name of ['GITLAB_BASE_URL', 'GITHUB_BASE_URL', 'JIRA_BASE_URL', 'PROJECT_HOSTS_ALLOW']) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    it('keeps the built-in lists and adds the extra hosts once', () => {
      expect(setupHosts(['pub.dev', 'pypi.org'])).toEqual([...setupHosts(), 'pub.dev']);
      expect(packageRegistries(['pub.dev'])).toEqual([...packageRegistries(), 'pub.dev']);
      expect(packageRegistries()).not.toContain('pub.dev');
    });

    it.each([
      ['github.com', 'is a code host'],
      ['gitlab.com', 'is a code host'],
      ['api.anthropic.com', 'is a model API host'],
      ['localhost', 'is a local address'],
      ['10.0.0.1', 'is a local address'],
      ['::1', 'is a local address'],
      ['https://pub.dev', 'is not a host name'],
      ['pub.dev', null],
      ['registry.npmjs.org', null],
    ])('the ceiling answers %p: %p', (host, reason) => {
      expect(hostRefusal(host, 'agent', [])).toBe(reason);
    });

    it('refuses the hosts of the code hosts, Jira and the checkout origin', () => {
      process.env.GITLAB_BASE_URL = 'https://git.corp.example/api/v4';
      process.env.GITHUB_BASE_URL = 'https://ghe.corp.example';
      process.env.JIRA_BASE_URL = 'https://corp.atlassian.net';
      for (const host of ['git.corp.example', 'ghe.corp.example', 'corp.atlassian.net', 'origin.example']) {
        expect(hostRefusal(host, 'setup', ['origin.example'])).toBe('is a code host');
      }
    });

    it('keeps the setup downloads away from the agent but not from the setup', () => {
      expect(hostRefusal('nodejs.org', 'agent', [])).toBe('is setup-only');
      expect(hostRefusal('nodejs.org', 'setup', [])).toBeNull();
      expect(hostRefusal('github.com', 'agent', [])).toBe('is a code host');
    });

    it('limits the manifest to PROJECT_HOSTS_ALLOW when it is set', () => {
      expect(hostRefusal('pub.dev', 'agent', [])).toBeNull();
      process.env.PROJECT_HOSTS_ALLOW = 'pub.dev, Storage.googleapis.com';
      expect(hostRefusal('pub.dev', 'agent', [])).toBeNull();
      expect(hostRefusal('storage.googleapis.com', 'setup', [])).toBeNull();
      expect(hostRefusal('example.org', 'agent', [])).toBe('is not in PROJECT_HOSTS_ALLOW');
      process.env.PROJECT_HOSTS_ALLOW = 'github.com';
      expect(hostRefusal('github.com', 'agent', [])).toBe('is a code host');
    });

    it('lets sandboxArgs launch a manifest host and refuses one that breaks the ceiling again', () => {
      const manifestHosts = { hosts: ['pub.dev'], origins: [] };
      const args = sandboxArgs(launch({ allowHosts: ['pub.dev'], manifestHosts }), home);
      expect(args).toEqual(sandboxArgs(launch({ allowHosts: ['pub.dev'], manifestHosts }), home));
      expect(() =>
        sandboxArgs(
          launch({ allowHosts: ['gitlab.com'], manifestHosts: { hosts: ['gitlab.com'], origins: [] } }),
          home,
        ),
      ).toThrow('gitlab.com is a code host');
      expect(() =>
        sandboxArgs(
          launch({
            allowHosts: ['git.corp.example'],
            manifestHosts: { hosts: ['git.corp.example'], origins: ['git.corp.example'] },
          }),
          home,
        ),
      ).toThrow('git.corp.example is a code host');
    });

    it('still refuses an allowed host that the manifest did not name', () => {
      expect(() =>
        sandboxArgs(
          launch({ allowHosts: ['pub.dev', 'api.example.com'], manifestHosts: { hosts: ['pub.dev'], origins: [] } }),
          home,
        ),
      ).toThrow('api.example.com is a production host');
      expect(() => sandboxArgs(launch({ allowHosts: ['pub.dev'] }), home)).toThrow('pub.dev is a production host');
    });
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
    expect(() => modelCredential('cursor', '', '', '')).toThrow('CURSOR_API_KEY is missing');
    expect(() => modelCredential('claude', '', '', '')).toThrow(
      'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing',
    );
    expect(modelCredential('claude', '', '', 'token')).toEqual({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token' });
    expect(modelCredential('claude', '', 'api-key', '')).toEqual({ name: 'ANTHROPIC_API_KEY', value: 'api-key' });
    const both = modelCredential('claude', '', 'api-key', 'token');
    expect(both).toEqual({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token' });
    const claude = sandboxArgs(launch({ env: [both], envMasks: [] }), home);
    expect(claude.filter((arg) => arg === '--env')).toEqual(['--env']);
    expect(claude[claude.indexOf('--env') + 1]).toBe('CLAUDE_CODE_OAUTH_TOKEN=token');
    expect(claude.join(' ')).not.toContain('ANTHROPIC_API_KEY');
    expect(modelCredential('cursor', 'cursor-key', 'api-key', 'token')).toEqual({
      name: 'CURSOR_API_KEY',
      value: 'cursor-key',
    });
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

  it('masks env files and leaves the example', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-env-mask-'));
    writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
    writeFileSync(join(root, '.env.example'), 'TOKEN=\n');
    mkdirSync(join(root, 'apps'));
    writeFileSync(join(root, 'apps', '.env.local'), 'TOKEN=secret\n');
    const masks = collectEnvMasks([{ hostPath: root, containerPath: '/work/demo' }]);
    expect(masks.map((mask) => mask.containerFile).sort()).toEqual(['/work/demo/.env', '/work/demo/apps/.env.local']);
  });

  describe('in a git checkout', () => {
    const masked = (root: string) =>
      collectEnvMasks([{ hostPath: root, containerPath: '/w' }])
        .map((mask) => mask.containerFile)
        .sort();

    it('leaves a tracked env file and masks an untracked one whatever its suffix', () => {
      const root = makeRepo({ '.env.sample': 'TOKEN=\n' });
      writeFiles(root, { '.env.local': 's\n', '.env.example': 's\n', '.env': 's\n' });
      expect(masked(root)).toEqual(['/w/.env', '/w/.env.example', '/w/.env.local']);
    });

    it.each(['node_modules', '.venv'])('does not walk an ignored %s', (folder) => {
      const root = makeRepo({ '.gitignore': `${folder}/\n` });
      writeFiles(root, { [`${folder}/pkg/.env`]: 's\n', '.env': 's\n' });
      expect(masked(root)).toEqual(['/w/.env']);
    });

    it('walks a node_modules that is not ignored like any folder', () => {
      const root = makeRepo();
      writeFiles(root, { 'node_modules/pkg/.env': 's\n' });
      expect(masked(root)).toEqual(['/w/node_modules/pkg/.env']);
    });

    it('treats a worktree, whose .git is a file, as a checkout', () => {
      const root = makeRepo({ '.env.sample': 'x\n' });
      const tree = join(mkdtempSync(join(tmpdir(), 'swarmloop-env-tree-')), 'wt');
      runGit(root, ['worktree', 'add', '-q', '-b', 'side', tree]);
      writeFiles(tree, { '.env.local': 's\n' });
      expect(masked(tree)).toEqual(['/w/.env.local']);
    });
  });

  it('does not scan Git metadata or treat file mounts as directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-file-mount-'));
    const pointer = join(root, 'worktree-link');
    writeFileSync(pointer, 'gitdir: /swarmloop-git/git-abcdef\n');
    writeFileSync(join(root, '.env'), 'not-a-project-secret\n');
    expect(
      collectEnvMasks([
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
      expect(args.slice(0, 4)).toEqual(['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}']);
      return '3.25% 2KiB / 64MiB\n';
    });
    await expect(sandbox.stats('swarmloop-plan')).resolves.toEqual({ cpuPercent: 3.25, rssBytes: 2 * 1024 });
  });
});

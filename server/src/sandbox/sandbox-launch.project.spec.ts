import { SwarmloopError } from '../core/swarmloop-error';
import { imageName } from './image-resolver';
import { home, launch } from './sandbox-launch.spec-helpers';
import { KEEP_PATH, sandboxArgs } from '../sandbox/sandbox-launch';

describe('sandbox launch', () => {
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
      expect(args.join(' ')).toContain('type=bind,src=/tmp/worktrees/.tmp/PROJ-1/research,dst=/tmp,readonly=false');
      expect(args[args.indexOf('--pids-limit') + 1]).toBe('1024');
      expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', 'no-new-privileges', '--read-only']));
      expect(args[args.indexOf('--user') + 1]).toBe('501:501');
    });

    it('mounts the run folder at /tmp from a volume or a host path, with no /tmp tmpfs', () => {
      const volume = sandboxArgs(
        launch({
          runtime: 'claude',
          command,
          project,
          tmp: {
            hostPath: '/tmp/worktrees/.tmp/PROJ-1/implement',
            volume: 'swarmloop-worktrees',
            volumeSubpath: '.tmp/PROJ-1/implement',
            containerPath: '/tmp',
          },
        }),
        home,
      );
      expect(volume.join(' ')).toContain(
        'type=volume,src=swarmloop-worktrees,volume-subpath=.tmp/PROJ-1/implement,dst=/tmp,readonly=false',
      );
      const host = sandboxArgs(launch({ runtime: 'claude', command, project }), home);
      for (const args of [volume, host]) {
        expect(args.filter((arg) => arg.startsWith('/tmp:'))).toEqual([]);
        expect(args[args.indexOf('--user') + 1]).toBe('501:501');
        expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', 'no-new-privileges', '--read-only']));
      }
    });

    it.each([
      ['no /tmp mount', undefined, 'sandbox /tmp is missing'],
      ['a /tmp at another path', { hostPath: '/tmp/worktrees/.tmp/a', containerPath: '/var/tmp' }, 'not allowed'],
      [
        'a read-only /tmp',
        { hostPath: '/tmp/worktrees/.tmp/a', containerPath: '/tmp', readonly: true },
        'sandbox /tmp is not allowed',
      ],
      ['a /tmp outside the work roots', { hostPath: '/etc/shared', containerPath: '/tmp' }, 'not allowed'],
    ])('refuses a project launch with %s', (_name, tmp, message) => {
      expect(() => sandboxArgs({ ...launch({ runtime: 'claude', command, project }), tmp }, home)).toThrow(message);
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
});

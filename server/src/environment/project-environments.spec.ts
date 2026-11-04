import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { makeRepo } from '../git/git-repo.spec-helpers';
import { ENVIRONMENT, type EnvironmentRecord, ProjectEnvironments } from './project-environments';

const manifest = {
  version: 1,
  image: 'node:22-bookworm-slim',
  setup: 'npm ci',
  checks: ['npm test'],
  cache: ['/home/sandbox/.npm'],
};

function setup(options: { probe?: string | Error; setupCode?: number; config?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-env-root-'));
  const repo = makeRepo({ '.swarmloop.json': JSON.stringify(options.config ?? manifest) });
  const stored: { kind: string; body: string }[] = [];
  const documents = {
    putDocument: jest.fn((_run: RunEntity, kind: string, body: string) => {
      stored.push({ kind, body });
      return Promise.resolve();
    }),
    latestBody: jest.fn((_key: string, kind: string) =>
      Promise.resolve([...stored].reverse().find((item) => item.kind === kind)?.body ?? null),
    ),
  };
  const spawned: SandboxLaunch[] = [];
  const run = jest.fn((args: string[]) => {
    const [first, second] = args;
    if (first === 'image' && second === 'inspect' && args.includes('{{.Id}}')) {
      return Promise.resolve('sha256:0123456789abcdef0123456789abcdef\n');
    }
    if (first === 'image' && second === 'inspect' && args.includes('{{json .Config.Env}}')) {
      return Promise.resolve('["PATH=/usr/local/bin:/usr/bin:/bin"]');
    }
    if (first === 'run' && args.includes('-c') && (args.at(-1) ?? '').includes('certs=')) {
      return options.probe instanceof Error
        ? Promise.reject(options.probe)
        : Promise.resolve(options.probe ?? 'certs=no\nv1\n');
    }
    if (first === 'run' && (args.at(-1) ?? '').startsWith('test -f')) {
      return Promise.resolve('yes\n');
    }
    return Promise.resolve('');
  });
  const sandbox = {
    run,
    stateDaemonPath: jest.fn((path: string) => Promise.resolve(path)),
    kill: jest.fn().mockResolvedValue(undefined),
    spawn: jest.fn((launch: SandboxLaunch) => {
      spawned.push(launch);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        containerName: 'swarmloop-r1-implement',
      });
      setImmediate(() => {
        child.stdout.write('added 12 packages\n');
        child.stderr.write('npm warn old\n');
        setImmediate(() => child.emit('close', options.setupCode ?? 0));
      });
      return Promise.resolve(child);
    }),
  };
  const env = testEnv({ RUNTIME: 'codex', SWARMLOOP_ROOT: root });
  const service = new ProjectEnvironments({
    env: () => env,
    clock: new FakeClock(),
    sandbox: sandbox as unknown as ConstructorParameters<typeof ProjectEnvironments>[0]['sandbox'],
    documents,
  });
  const input = {
    run: {} as RunEntity,
    key: 'r1',
    step: 'implement',
    mounts: [{ hostPath: repo, containerPath: '/work' }],
  };
  const records = () =>
    stored.filter((item) => item.kind === ENVIRONMENT).map((item) => JSON.parse(item.body) as EnvironmentRecord);
  return { service, sandbox, input, spawned, records, run };
}

describe('ProjectEnvironments', () => {
  it('returns null for a repository without an environment', async () => {
    const { service, input, sandbox } = setup();
    const bare = { ...input, mounts: [{ hostPath: makeRepo(), containerPath: '/work' }] };
    expect(await service.prepare(bare)).toBeNull();
    expect(sandbox.spawn).not.toHaveBeenCalled();
  });

  it('prepares the project image with the CLI volume, the image PATH, its caches and the certificates', async () => {
    const { service, input } = setup();
    const prepared = await service.prepare(input);
    expect(prepared?.launch).toMatchObject({
      image: 'node:22-bookworm-slim',
      cliVolume: 'swarmloop-cli-codex-0123456789ab',
      path: '/usr/local/bin:/usr/bin:/bin',
      certFile: true,
    });
    expect(prepared?.launch.caches.map((cache) => cache.containerPath)).toEqual(['/home/sandbox/.npm']);
    expect(prepared?.record.config.checks).toEqual(['npm test']);
  });

  it('uses the image CA bundle when it has one', async () => {
    const { service, input } = setup({ probe: 'certs=yes\nv1\n' });
    expect((await service.prepare(input))?.launch.certFile).toBe(false);
  });

  it('runs the setup once, in the project image, without a model key, and keeps its result', async () => {
    const { service, input, spawned, records } = setup();
    await service.prepare(input);
    await service.prepare({ ...input, step: 'implement-improve' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.project?.shell).toBe('npm ci');
    expect(spawned[0]?.command).toEqual([]);
    expect(spawned[0]?.env).toBeUndefined();
    expect(spawned[0]?.allowHosts.length).toBeGreaterThan(0);
    expect(records().at(-1)?.setup).toMatchObject({ command: 'npm ci', exitCode: 0 });
    expect(records().at(-1)?.setup?.tail).toContain('added 12 packages');
  });

  it('does not run a failed setup again and keeps its tail for the agent', async () => {
    const { service, input, spawned, records } = setup({ setupCode: 1 });
    const prepared = await service.prepare(input);
    await service.prepare(input);
    expect(spawned).toHaveLength(1);
    expect(prepared?.record.setup?.exitCode).toBe(1);
    expect(records().at(-1)?.setup?.tail).toContain('npm warn old');
  });

  it('keeps the config the run started with', async () => {
    const { service, input, records } = setup();
    await service.prepare(input);
    const first = records().length;
    await service.prepare(input);
    expect(records()).toHaveLength(first);
  });

  it('says what to use when the CLI does not start in the image', async () => {
    const { service, input } = setup({
      config: { version: 1, image: 'node:22-alpine' },
      probe: new Error("env: can't execute 'bash': No such file or directory"),
    });
    await expect(service.prepare(input)).rejects.toThrow(
      /node:22-alpine: the codex CLI does not start there .*bash.*Debian or Ubuntu/,
    );
  });
});

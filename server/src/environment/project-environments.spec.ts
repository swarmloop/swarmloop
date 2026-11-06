import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { commitFiles, makeRepo, runGit } from '../git/git-repo.spec-helpers';
import { ENVIRONMENT, type EnvironmentRecord, ProjectEnvironments, RequiredCheckFailed } from './project-environments';

const manifest = {
  version: 1,
  image: 'node:22-bookworm-slim',
  setup: 'npm ci',
  checks: ['npm test'],
  cache: ['/home/sandbox/.npm'],
};

function setup(
  options: {
    probe?: string | Error;
    setupCode?: number;
    checkCode?: number;
    config?: unknown;
    onCheck?: (repo: string) => void;
    imageId?: () => string;
  } = {},
) {
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
      return Promise.resolve(
        (args.at(-1) === manifest.image ? options.imageId?.() : undefined) ??
          'sha256:0123456789abcdef0123456789abcdef\n',
      );
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
        if (launch.allowHosts.length === 0) {
          options.onCheck?.(repo);
        }
        child.stdout.write('added 12 packages\n');
        child.stderr.write('npm warn old\n');
        setImmediate(() =>
          child.emit('close', launch.allowHosts.length ? (options.setupCode ?? 0) : (options.checkCode ?? 0)),
        );
      });
      return Promise.resolve(child);
    }),
  };
  const live = { log: jest.fn() };
  const env = testEnv({ RUNTIME: 'codex', SWARMLOOP_ROOT: root });
  const service = new ProjectEnvironments({
    env: () => env,
    clock: new FakeClock(),
    sandbox: sandbox as unknown as ConstructorParameters<typeof ProjectEnvironments>[0]['sandbox'],
    documents,
    live,
  });
  const input = {
    run: {} as RunEntity,
    key: 'r1',
    step: 'implement',
    mounts: [{ hostPath: repo, containerPath: '/work' }],
  };
  const records = () =>
    stored.filter((item) => item.kind === ENVIRONMENT).map((item) => JSON.parse(item.body) as EnvironmentRecord);
  return { service, sandbox, input, spawned, records, run, stored, live };
}

describe('ProjectEnvironments', () => {
  it('requires a trusted base before rebuilding a legacy Dockerfile environment', async () => {
    const { service, input, stored, sandbox } = setup();
    stored.push({
      kind: ENVIRONMENT,
      body: JSON.stringify({
        repo: input.mounts[0].hostPath.split('/').at(-1),
        config: { dockerfile: 'Dockerfile', checks: [], cache: [] },
      }),
    });
    await expect(service.prepare(input)).rejects.toThrow('Rebase this run');
    expect(sandbox.spawn).not.toHaveBeenCalled();
  });

  it('freezes the initial revision and skips absent environments without hiding another repository', async () => {
    const { service, input, stored, records } = setup();
    const absent = makeRepo();
    const mounts = [{ hostPath: absent, containerPath: '/work/empty' }, ...input.mounts];
    const base = runGit(input.mounts[0].hostPath, ['rev-parse', 'HEAD']).trim();
    await service.prepare({ ...input, mounts });
    expect(records().at(-1)?.ref).toBe(base);
    commitFiles(input.mounts[0].hostPath, { '.swarmloop.json': JSON.stringify({ ...manifest, checks: ['true'] }) });
    expect(await service.prepare({ ...input, mounts })).not.toBeNull();
    expect(records().at(-1)?.config.checks).toEqual(['npm test']);
    expect(stored.some((item) => item.body === 'null')).toBe(true);
  });

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
    expect(spawned[0]?.allowHosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'github.com', 'nodejs.org']));
    expect(records().at(-1)?.setup).toMatchObject({ command: 'npm ci', exitCode: 0 });
    expect(records().at(-1)?.setup?.tail).toContain('added 12 packages');
  });

  it('stops on a failed setup and retries it on the next attempt', async () => {
    const { service, input, spawned, records } = setup({ setupCode: 1 });
    await expect(service.prepare(input)).rejects.toThrow('environment setup failed (exit 1)');
    await expect(service.prepare(input)).rejects.toThrow('environment setup failed (exit 1)');
    expect(spawned).toHaveLength(2);
    expect(records().at(-1)?.setup?.tail).toContain('npm warn old');
  });

  it('runs required checks without model credentials and records actual exit codes', async () => {
    const { service, input, spawned, stored } = setup();
    await service.check(input);
    expect(spawned.map((launch) => launch.project?.shell)).toEqual(['npm ci', 'npm test']);
    expect(spawned[1]?.allowHosts).toEqual([]);
    expect(spawned[1]?.env).toBeUndefined();
    expect(JSON.parse(stored.find((document) => document.kind === 'checks')!.body)).toMatchObject({
      command: 'npm test',
      exitCode: 0,
    });
  });

  it('stops at the first failed check and leaves feedback for the next implementation attempt', async () => {
    const { service, input, spawned, stored } = setup({
      checkCode: 2,
      config: { ...manifest, checks: ['php test.php', 'python3 test.py'] },
    });
    await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
    expect(spawned.map((launch) => launch.project?.shell)).toEqual(['npm ci', 'php test.php']);
    expect(stored.find((document) => document.kind === 'return')?.body).toContain('php test.php');
  });

  it('uses each repository image and checks instead of reusing the first environment', async () => {
    const { service, input, spawned } = setup();
    const other = makeRepo({
      '.swarmloop.json': JSON.stringify({ version: 1, image: 'python:3.12', checks: ['python3 -m unittest'] }),
    });
    const mounts = [...input.mounts, { hostPath: other, containerPath: '/work/other' }];
    await service.check({ ...input, mounts });
    expect(spawned.map((launch) => launch.project?.shell)).toEqual(['npm ci', 'npm test', 'python3 -m unittest']);
    expect(spawned[2]?.project?.image).toBe('python:3.12');
    expect(spawned[2]?.mounts[0]?.hostPath).toBe(other);
    await service.check({ ...input, mounts });
    expect(spawned.filter((launch) => launch.project?.shell === 'npm ci')).toHaveLength(1);
  });

  it('does not accept checks that rewrite the project after testing it', async () => {
    const { service, input, stored } = setup({
      onCheck: (repo) => writeFileSync(join(repo, 'changed.py'), 'print(2)\n'),
    });
    await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
    expect(stored.find((document) => document.kind === 'return')?.body).toContain('rerun the checks');
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

  describe('the checks gate on unchanged files', () => {
    const ran = (spawned: SandboxLaunch[]) => spawned.filter((launch) => launch.project?.shell === 'npm test').length;
    const checkDocs = (stored: { kind: string; body: string }[]) =>
      stored.filter((item) => item.kind === 'checks').map((item) => JSON.parse(item.body) as Record<string, unknown>);

    it('skips a second check on the same files with one skipped document and a log line', async () => {
      const { service, input, spawned, stored, live } = setup();
      await service.check(input);
      await service.check({ ...input, step: 'implement-improve' });
      expect(ran(spawned)).toBe(1);
      const tail = 'skipped: these checks passed on the same files in implement';
      expect(checkDocs(stored).at(-1)).toEqual({
        repo: expect.any(String),
        skipped: true,
        sameAs: 'implement',
        exitCode: 0,
        tail,
      });
      expect(checkDocs(stored)).toHaveLength(2);
      expect(live.log).toHaveBeenCalledWith({ key: 'r1', step: 'implement-improve', body: `${tail}\n` });
    });

    it.each([
      [
        'a tracked file changes',
        (repo: string) => writeFileSync(join(repo, '.swarmloop.json'), `${JSON.stringify(manifest)}\n`),
      ],
      ['an untracked file appears', (repo: string) => writeFileSync(join(repo, 'new.txt'), 'x\n')],
      [
        'HEAD moves',
        (repo: string) => {
          commitFiles(repo, { 'moved.txt': 'x\n' });
        },
      ],
    ])('runs all checks when %s', async (_name, change) => {
      const { service, input, spawned } = setup();
      await service.check(input);
      change(input.mounts[0].hostPath);
      await service.check(input);
      expect(ran(spawned)).toBe(2);
    });

    it('runs all checks when another mounted repository changes', async () => {
      const { service, input, spawned } = setup();
      const other = makeRepo();
      const mounts = [...input.mounts, { hostPath: other, containerPath: '/work/other' }];
      await service.check({ ...input, mounts });
      writeFileSync(join(other, 'edit.txt'), 'x\n');
      await service.check({ ...input, mounts });
      expect(ran(spawned)).toBe(2);
    });

    it('runs all checks when the image id differs', async () => {
      let id = 'sha256:a\n';
      const { service, input, spawned } = setup({ imageId: () => id });
      await service.check(input);
      id = 'sha256:b\n';
      await service.check(input);
      expect(ran(spawned)).toBe(2);
    });

    it.each([
      ['a failed command', { checkCode: 2 }],
      ['a timeout', { checkCode: 124 }],
      [
        'a check that changes project files',
        { onCheck: (repo: string) => writeFileSync(join(repo, 'c.py'), `${Math.random()}\n`) },
      ],
    ])('stores no pass after %s, so the next check runs in full', async (_name, options) => {
      const { service, input, spawned, stored } = setup(options);
      await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
      expect(stored.some((item) => item.kind.startsWith('checks_pass:'))).toBe(false);
      await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
      expect(ran(spawned)).toBe(2);
    });

    it('throws RequiredCheckFailed with the failing command output', async () => {
      const { service, input } = setup({ checkCode: 3 });
      await expect(service.check(input)).rejects.toThrow(/: required check failed \(exit 3\):\n\$ npm test/);
    });
  });
});

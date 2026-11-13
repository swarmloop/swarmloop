import { EventEmitter } from 'events';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { PassThrough } from 'stream';
import { testEnv } from '../config/env.spec-helpers';
import { resolveRepoRoot } from '../config/repo-root';
import { readCheckOutput } from '../core/check-output';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { CheckCommandEntity, RunEntity } from '../history/entities';
import type { SampleDraft } from '../history/visit';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { commitFiles, makeRepo, runGit, writeFiles } from '../git/git-repo.spec-helpers';
import type { EnvironmentRecord } from './environment-types';
import { ENVIRONMENT, ProjectEnvironments, RequiredCheckFailed, RequiredCheckRepeated } from './project-environments';

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
    /** The exit code of one check command, by its text. */
    checkExit?: (command: string) => number;
    /** How many turns of the event loop a check container stays alive. */
    checkTurns?: number;
    /** The lines a check writes. */
    checkLines?: number;
    config?: unknown;
    onCheck?: (repo: string) => void;
    imageId?: () => string;
    /** The line a queued container hears from the budget before it starts. */
    wait?: string;
    /** The runtime of the server's agent lists. An agent's own runtime never comes from it. */
    RUNTIME?: 'claude' | 'codex';
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
  const alive = { now: 0, max: 0 };
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
  const rows: CheckCommandEntity[] = [];
  const commands = {
    add: jest.fn((draft: Partial<CheckCommandEntity>) => {
      const row = {
        id: rows.length + 1,
        status: 'waiting',
        skipped: 0,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        ...draft,
      } as CheckCommandEntity;
      rows.push(row);
      return Promise.resolve(row);
    }),
    save: jest.fn((row: CheckCommandEntity) => Promise.resolve(row)),
  };
  const sandbox = {
    run,
    stats: jest.fn().mockResolvedValue({ cpuPercent: 5, rssBytes: 1024 }),
    stateDaemonPath: jest.fn((path: string) => Promise.resolve(path)),
    kill: jest.fn().mockResolvedValue(undefined),
    spawn: jest.fn((launch: SandboxLaunch) => {
      spawned.push(launch);
      if (options.wait) {
        launch.onWait?.(options.wait);
      }
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        containerName: 'swarmloop-r1-implement',
      });
      const isCheck = launch.allowHosts.length === 0;
      if (isCheck) {
        alive.now += 1;
        alive.max = Math.max(alive.max, alive.now);
      }
      setImmediate(() => {
        if (isCheck) {
          options.onCheck?.(repo);
        }
        child.stdout.write('added 12 packages\n');
        child.stderr.write('npm warn old\n');
        if (isCheck && options.checkLines) {
          child.stdout.write(`${Array.from({ length: options.checkLines }, (_, line) => `line ${line}`).join('\n')}\n`);
        }
        const code = isCheck
          ? (options.checkExit?.(launch.project?.shell ?? '') ?? options.checkCode ?? 0)
          : (options.setupCode ?? 0);
        // A check container stays alive for a few turns of the event loop, so containers overlap when they may.
        const close = (turns: number): void => {
          if (turns > 0) {
            setImmediate(() => close(turns - 1));
            return;
          }
          if (isCheck) {
            alive.now -= 1;
          }
          child.emit('close', code);
        };
        close(isCheck ? (options.checkTurns ?? 0) : 0);
      });
      return Promise.resolve(child);
    }),
  };
  const live = { log: jest.fn(), changed: jest.fn() };
  const listed = `${options.RUNTIME ?? 'codex'}:m`;
  const env = testEnv({
    AGENTS_PLAN: listed,
    AGENTS_IMPLEMENT: listed,
    AGENTS_REVIEW: listed,
    SWARMLOOP_ROOT: root,
  });
  const service = new ProjectEnvironments({
    env: () => env,
    clock: new FakeClock(),
    sandbox: sandbox as unknown as ConstructorParameters<typeof ProjectEnvironments>[0]['sandbox'],
    documents,
    commands,
    live,
  });
  const input = {
    run: {} as RunEntity,
    key: 'r1',
    step: 'implement',
    mounts: [{ hostPath: repo, containerPath: '/work' }],
    runtime: 'codex' as const,
  };
  const records = () =>
    stored.filter((item) => item.kind === ENVIRONMENT).map((item) => JSON.parse(item.body) as EnvironmentRecord);
  return { service, sandbox, input, spawned, records, run, stored, live, rows, alive, root };
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

  it('builds the CLI volume and runs the setup for the runtime of the agent, not the global RUNTIME', async () => {
    const { service, input, spawned } = setup({ RUNTIME: 'claude' });
    const prepared = await service.prepare({ ...input, runtime: 'codex' });
    expect(prepared?.launch.cliVolume).toBe('swarmloop-cli-codex-0123456789ab');
    expect(spawned.map((launch) => launch.runtime)).toEqual(['codex']);
    expect((await service.prepare({ ...input, runtime: 'claude' }))?.launch.cliVolume).toBe(
      'swarmloop-cli-claude-0123456789ab',
    );
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

  it('adds the manifest hosts to the setup and gives the checks none', async () => {
    const config = { ...manifest, hosts: { setup: ['pub.dev', 'storage.googleapis.com'], agent: ['pub.dev'] } };
    const { service, input, spawned } = setup({ config });
    await service.check(input);
    expect(spawned[0]?.allowHosts).toEqual(
      expect.arrayContaining(['registry.npmjs.org', 'github.com', 'pub.dev', 'storage.googleapis.com']),
    );
    expect(spawned[0]?.manifestHosts?.hosts).toEqual(['pub.dev', 'storage.googleapis.com']);
    expect(spawned[1]?.allowHosts).toEqual([]);
    expect(spawned[1]?.manifestHosts).toBeUndefined();
  });

  it('stops at prepare on a manifest host above the ceiling', async () => {
    const config = { ...manifest, hosts: { setup: ['gitlab.com'] } };
    const { service, input, spawned } = setup({ config });
    await expect(service.prepare(input)).rejects.toThrow('.swarmloop.json: hosts.setup: gitlab.com is a code host');
    expect(spawned).toHaveLength(0);
  });

  it('gives no launch a host that only the worktree manifest names', async () => {
    const { service, input, spawned } = setup();
    writeFiles(input.mounts[0]?.hostPath ?? '', {
      '.swarmloop.json': JSON.stringify({ ...manifest, hosts: { setup: ['pub.dev'] } }),
    });
    await service.prepare(input);
    expect(spawned[0]?.allowHosts).not.toContain('pub.dev');
    expect(spawned[0]?.manifestHosts).toBeUndefined();
  });

  it('stops on a failed setup and retries it on the next attempt', async () => {
    const { service, input, spawned, records } = setup({ setupCode: 1 });
    await expect(service.prepare(input)).rejects.toThrow('environment setup failed (exit 1)');
    await expect(service.prepare(input)).rejects.toThrow('environment setup failed (exit 1)');
    expect(spawned).toHaveLength(2);
    expect(records().at(-1)?.setup?.tail).toContain('npm warn old');
  });

  it('shows a queued check and a queued setup the wait line live only, then their normal output', async () => {
    const wait = 'waiting for machine resources: 2 checks run';
    const { service, input, live, stored, root } = setup({ wait });
    await service.check(input);
    const logs = live.log.mock.calls.map(([entry]: [{ body: string; command?: number }]) => entry);
    const waited = logs.filter((entry) => entry.body.includes(wait));
    expect(waited.some((entry) => entry.command === 0)).toBe(true);
    expect(waited.some((entry) => entry.command === undefined)).toBe(true);
    const lastCheck = logs.filter((entry) => entry.command === 0).at(-1);
    expect(lastCheck?.body).toContain('added 12 packages');
    expect(lastCheck?.body).not.toContain(wait);
    const record = JSON.parse(stored.find((document) => document.kind === 'checks')!.body);
    expect(JSON.stringify(record)).not.toContain(wait);
    const files = readdirSync(join(root, 'data'), { withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(join(root, 'data', file.name), 'utf8')).not.toContain(wait);
    }
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
    expect(spawned.map((launch) => launch.project?.shell)).toEqual(['npm ci', 'php test.php', 'python3 test.py']);
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

    it('stamps a pass with the generation and runs all checks again in the next generation', async () => {
      const { service, input, spawned, stored } = setup();
      input.run.generation = 0;
      await service.check(input);
      const pass = stored.find((item) => item.kind.startsWith('checks_pass:'));
      expect(JSON.parse(pass?.body ?? '{}')).toMatchObject({ generation: 0, fingerprint: expect.any(String) });
      input.run.generation = 1;
      await service.check(input);
      expect(ran(spawned)).toBe(2);
      expect(
        JSON.parse(stored.filter((item) => item.kind.startsWith('checks_pass:')).at(-1)?.body ?? '{}'),
      ).toMatchObject({
        generation: 1,
      });
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

  describe('a failed check that repeats', () => {
    const failures = (stored: { kind: string; body: string }[]) =>
      stored
        .filter((item) => item.kind.startsWith('checks_fail:'))
        .map((item) => JSON.parse(item.body) as Record<string, string>);

    it('stores the failed command, the fingerprint, the step and the time', async () => {
      const { service, input, stored } = setup({ checkCode: 2 });
      await expect(service.check(input)).rejects.not.toBeInstanceOf(RequiredCheckRepeated);
      expect(failures(stored)).toEqual([
        { command: 'npm test', fingerprint: expect.any(String), step: 'implement', at: expect.any(String) },
      ]);
    });

    it('throws RequiredCheckRepeated for the same command on unchanged files and keeps the return notes', async () => {
      const { service, input, stored } = setup({ checkCode: 2 });
      await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
      await expect(service.check({ ...input, step: 'implement-improve' })).rejects.toThrow(
        new RequiredCheckRepeated(
          `${basename(input.mounts[0].hostPath)}: npm test failed again on unchanged files after a relaunch`,
        ),
      );
      expect(stored.filter((item) => item.kind === 'return').at(-1)?.body).toContain('required check failed (exit 2)');
    });

    it('throws a plain RequiredCheckFailed when the files changed in between', async () => {
      const { service, input } = setup({ checkCode: 2 });
      await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
      writeFileSync(join(input.mounts[0].hostPath, 'new.txt'), 'x\n');
      await expect(service.check(input)).rejects.not.toBeInstanceOf(RequiredCheckRepeated);
    });

    it('throws a plain RequiredCheckFailed when another command failed on the same files', async () => {
      const { service, input, stored } = setup({ checkCode: 2 });
      await expect(service.check(input)).rejects.toThrow(RequiredCheckFailed);
      const [first] = failures(stored);
      stored.push({
        kind: stored.find((item) => item.kind.startsWith('checks_fail:'))!.kind,
        body: JSON.stringify({ ...first, command: 'npm run lint' }),
      });
      await expect(service.check(input)).rejects.not.toBeInstanceOf(RequiredCheckRepeated);
    });

    it('writes nothing on a pass', async () => {
      const { service, input, stored } = setup();
      await service.check(input);
      expect(failures(stored)).toEqual([]);
    });
  });
});

describe('ProjectEnvironments checks', () => {
  const twelve = Array.from({ length: 12 }, (_, index) => `npm run check-${index}`);
  const failing = new Set([twelve[3], twelve[7], twelve[11]]);

  it('runs every command and returns once with all failed commands named', async () => {
    const { service, input, spawned, stored, rows } = setup({
      config: { ...manifest, checks: twelve },
      checkExit: (command) => (failing.has(command) ? 1 : 0),
    });
    const error = await service.check(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequiredCheckFailed);
    expect(error).not.toBeInstanceOf(RequiredCheckRepeated);
    expect(spawned.filter((launch) => launch.allowHosts.length === 0)).toHaveLength(12);
    const returned = stored.filter((document) => document.kind === 'return');
    expect(returned).toHaveLength(1);
    for (const command of failing) {
      expect(returned[0].body).toContain(`$ ${command}`);
    }
    expect(returned[0].body.match(/required check failed \(exit 1\)/g)).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'failed').map((row) => row.command)).toEqual([...failing]);
    expect(rows.filter((row) => row.status === 'passed')).toHaveLength(9);
  });

  it('carries the failed commands as data on RequiredCheckFailed', async () => {
    const { service, input } = setup({
      config: { ...manifest, checks: ['npm test', 'npm run lint'] },
      checkExit: (command) => (command === 'npm run lint' ? 1 : 0),
    });
    const error = (await service.check(input).catch((caught: unknown) => caught)) as RequiredCheckFailed;
    expect(error.failed).toEqual([
      {
        repo: basename(input.mounts[0].hostPath),
        command: 'npm run lint',
        tail: expect.stringContaining('$ npm run lint') as string,
      },
    ]);
  });

  describe('rerun', () => {
    const commands = ['npm test', 'npm run lint', 'npm run types'];
    const config = { ...manifest, checks: commands };

    it('runs only the named commands the project still lists, and records nothing', async () => {
      const { service, input, spawned, stored, rows } = setup({ config });
      const repo = basename(input.mounts[0].hostPath);
      await service.prepare(input);
      const known = { rows: rows.length, stored: stored.length, spawned: spawned.length };
      const red = await service.rerun(input, [
        { repo, command: 'npm run lint', tail: '' },
        { repo, command: 'npm run removed', tail: '' },
        { repo: 'other-repo', command: 'npm test', tail: '' },
      ]);
      expect(red).toEqual([]);
      expect(spawned.slice(known.spawned).map((launch) => launch.project?.shell)).toEqual(['npm run lint']);
      expect(spawned.at(-1)?.allowHosts).toEqual([]);
      expect({ rows: rows.length, stored: stored.length }).toEqual({ rows: known.rows, stored: known.stored });
    });

    it('returns the commands that are still red with their new tail', async () => {
      const { service, input } = setup({
        config,
        checkExit: (command) => (command === 'npm run types' ? 1 : 0),
      });
      const repo = basename(input.mounts[0].hostPath);
      const red = await service.rerun(
        input,
        commands.map((command) => ({ repo, command, tail: 'old' })),
      );
      expect(red).toEqual([
        { repo, command: 'npm run types', tail: expect.stringContaining('$ npm run types') as string },
      ]);
    });
  });

  it('never has more check containers alive than CHECKS_PARALLEL', async () => {
    const { service, input, alive } = setup({ config: { ...manifest, checks: twelve }, checkTurns: 5 });
    await service.check(input);
    expect(alive.max).toBe(3);
  });

  it('numbers the commands of every repository and keeps their rows', async () => {
    const { service, input, rows } = setup({ config: { ...manifest, checks: ['npm test', 'npm run lint'] } });
    await service.check({ ...input, run: { id: 4, activeAttempt: 'a1' } as RunEntity });
    expect(
      rows.map((row) => [row.runId, row.attemptId, row.commandIndex, row.command, row.status, row.exitCode]),
    ).toEqual([
      [4, 'a1', 0, 'npm test', 'passed', 0],
      [4, 'a1', 1, 'npm run lint', 'passed', 0],
    ]);
  });

  it('marks the commands of a repository skipped when they passed on the same files', async () => {
    const { service, input, rows, spawned } = setup();
    await service.check(input);
    const before = spawned.length;
    await service.check(input);
    expect(spawned).toHaveLength(before);
    expect(rows.at(-1)).toMatchObject({ status: 'skipped', skipped: 1 });
  });

  describe('commands with a name and paths', () => {
    const entries = [
      'npm test server',
      { run: 'npm run e2e', name: 'end to end' },
      { run: 'npm test --prefix server', name: 'server tests', paths: ['server/'] },
    ];

    it('names a string entry by its label and an object entry by its name', async () => {
      const { service, input, rows } = setup({ config: { ...manifest, checks: entries } });
      await service.check(input);
      expect(rows.map((row) => [row.command, row.name])).toEqual([
        ['npm test server', 'npm test server'],
        ['npm run e2e', 'end to end'],
        ['npm test --prefix server', 'server tests'],
      ]);
    });

    it('skips a command whose paths the diff does not touch and counts it as passed', async () => {
      const { service, input, rows, spawned, stored, live } = setup({ config: { ...manifest, checks: entries } });
      writeFiles(input.mounts[0].hostPath, { 'dashboard/app.ts': 'x\n' });
      const done = await service.check(input);
      expect(done).toEqual({ passed: 3, total: 3 });
      expect(rows.map((row) => [row.commandIndex, row.status])).toEqual([
        [0, 'passed'],
        [1, 'passed'],
        [2, 'skipped'],
      ]);
      expect(spawned.filter((launch) => launch.allowHosts.length === 0)).toHaveLength(2);
      const tail = 'no change under server/';
      expect(stored.map((item) => item.body).some((body) => body.includes(`"tail":"${tail}"`))).toBe(true);
      expect(live.log).toHaveBeenCalledWith(expect.objectContaining({ body: `server tests: ${tail}\n` }));
      const skipped = stored.find((item) => item.kind === 'checks_skipped:' + basename(input.mounts[0].hostPath));
      expect(JSON.parse(skipped?.body ?? '{}')).toMatchObject({ names: ['server tests'] });
    });

    it('runs a command when the diff touches its paths, tracked or untracked', async () => {
      const untracked = setup({ config: { ...manifest, checks: entries } });
      writeFiles(untracked.input.mounts[0].hostPath, { 'server/src/x.ts': 'x\n' });
      await untracked.service.check(untracked.input);
      expect(untracked.rows.at(-1)?.status).toBe('passed');

      const tracked = setup({ config: { ...manifest, checks: entries } });
      const repo = tracked.input.mounts[0].hostPath;
      commitFiles(repo, { 'server/a.ts': 'a\n' });
      writeFiles(repo, { 'server/a.ts': 'b\n' });
      await tracked.service.check(tracked.input);
      expect(tracked.rows.at(-1)?.status).toBe('passed');
    });

    it('runs a command that the last return named although its paths are untouched', async () => {
      const { service, input, rows } = setup({ config: { ...manifest, checks: entries } });
      const repo = basename(input.mounts[0].hostPath);
      writeFiles(input.mounts[0].hostPath, { 'dashboard/app.ts': 'x\n' });
      await service.check(input, [{ repo, command: 'npm test --prefix server', tail: '' }]);
      expect(rows.at(-1)?.status).toBe('passed');
    });

    it('replaces the stored skips when a later visit runs the command', async () => {
      const { service, input, stored } = setup({ config: { ...manifest, checks: entries } });
      const kind = `checks_skipped:${basename(input.mounts[0].hostPath)}`;
      await service.check(input);
      expect(JSON.parse(stored.filter((item) => item.kind === kind).at(-1)?.body ?? '{}').names).toEqual([
        'server tests',
      ]);
      writeFiles(input.mounts[0].hostPath, { 'server/src/x.ts': 'x\n' });
      await service.check(input);
      expect(JSON.parse(stored.filter((item) => item.kind === kind).at(-1)?.body ?? '{}').names).toEqual([]);
    });

    it('lets the fingerprint skip win over the paths', async () => {
      const { service, input, rows, spawned } = setup({ config: { ...manifest, checks: entries } });
      await service.check(input);
      const before = spawned.length;
      await service.check(input);
      expect(spawned).toHaveLength(before);
      expect(rows.slice(-3).map((row) => row.status)).toEqual(['skipped', 'skipped', 'skipped']);
    });
  });

  it('writes the full output of a long command to its own file', async () => {
    const { service, input, root } = setup({ checkLines: 50_000 });
    await service.check({ ...input, run: { id: 1, activeAttempt: 'attempt-1' } as RunEntity });
    const text = readCheckOutput(resolveRepoRoot(root, __dirname), 'r1', 'implement', 'attempt-1', 0);
    expect(text?.split('\n').filter((line) => line.startsWith('line '))).toHaveLength(50_000);
  });

  it('samples the setup container and every check container with their source', async () => {
    const { service, input } = setup({ config: { ...manifest, checks: ['npm test', 'npm run lint'] } });
    const samples: SampleDraft[] = [];
    await service.check({ ...input, samples });
    expect(samples.map((sample) => sample.source).sort()).toEqual(['0', '1', 'setup']);
    expect(samples[0]).toMatchObject({ cpuPercent: 5, rssBytes: 1024 });
  });
});

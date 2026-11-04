import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { SandboxService } from '../sandbox/sandbox.service';
import { makeRepo, writeFiles } from './git-repo.spec-helpers';
import { VerifyOutputLine, VerifyService } from './verify.service';

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
  /** Emits close with this code as soon as the container is killed. */
  closeOnKill?: number;
  effect?: () => void;
}

const files = {
  '.gitignore': 'data/\nnode_modules/\n',
  'package.json': '{"name":"x"}\n',
  'package-lock.json': '{"lock":1}\n',
};

function manifest(patch: Record<string, unknown> = {}): Record<string, string> {
  const body = { version: 1, image: 'node:22', install: 'npm ci', verify: ['npm test'], ...patch };
  return { ...files, '.swarmloop.json': JSON.stringify(body) };
}

function child(script: Script): EventEmitter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = Object.assign(new EventEmitter(), { stdout, stderr, containerName: 'swarmloop-r1-verify' });
  script.effect?.();
  if (script.stdout) {
    stdout.write(script.stdout);
  }
  if (script.stderr) {
    stderr.write(script.stderr);
  }
  if (!script.hang) {
    setImmediate(() => emitter.emit('close', script.code ?? 0));
  }
  return emitter;
}

function setup(scripts: Script[]) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-verify-root-'));
  const clock = new FakeClock();
  let closeOnKill: (() => void) | null = null;
  const spawnDocker = jest.fn(() => {
    const script = scripts.shift() ?? {};
    const spawned = child(script);
    closeOnKill = script.closeOnKill === undefined ? null : () => spawned.emit('close', script.closeOnKill);
    return spawned;
  });
  const sandbox = {
    run: jest.fn().mockResolvedValue(''),
    remove: jest.fn().mockResolvedValue(undefined),
    kill: jest.fn(() => {
      closeOnKill?.();
      return Promise.resolve();
    }),
    ensureNetwork: jest.fn().mockResolvedValue(undefined),
    stateDaemonPath: jest.fn((path: string) => Promise.resolve(path)),
    withDaemonPaths: jest.fn((mounts: object[]) => Promise.resolve(mounts)),
    maskFor: jest.fn().mockResolvedValue('/mask'),
    spawnDocker,
  };
  const service = new VerifyService(
    new AppConfig(testEnv({ SWARMLOOP_ROOT: root })),
    clock,
    sandbox as unknown as SandboxService,
  );
  return { service, sandbox, spawnDocker, clock, root };
}

function input(repo: string, patch: Record<string, unknown> = {}) {
  return { runKey: 'r1', project: 'demo', worktree: repo, baseRef: 'main', ...patch };
}

function commandsRun(spawnDocker: jest.Mock): string[] {
  return spawnDocker.mock.calls.map((call) => (call[0] as string[]).at(-1) ?? '');
}

afterEach(() => {
  jest.useRealTimers();
});

describe('VerifyService', () => {
  it('skips a project without a manifest', async () => {
    const { service, spawnDocker } = setup([]);
    expect(await service.run(input(makeRepo()))).toEqual({ status: 'skipped' });
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it('runs install and every verify command and streams the output', async () => {
    const repo = makeRepo(manifest({ verify: ['npm test'] }));
    const { service, clock } = setup([
      { stdout: 'one\n', stderr: 'two\n' },
      { stdout: 'partial', effect: () => clock.advance(3000) },
    ]);
    const lines: VerifyOutputLine[] = [];
    const result = await service.run(input(repo, { onOutput: (line: VerifyOutputLine) => lines.push(line) }));
    expect(result).toMatchObject({ status: 'ok', warnings: [], installChanged: [], durationMs: 3000 });
    expect(lines.map((line) => line.text)).toEqual([
      '$ npm ci',
      'one',
      'two',
      'exit 0 (0s)',
      '$ npm test',
      'partial',
      'exit 0 (3s)',
    ]);
    expect(lines.map((line) => line.stream)).toEqual([
      'stdout',
      'stdout',
      'stderr',
      'stdout',
      'stdout',
      'stdout',
      'stdout',
    ]);
    if (result.status !== 'skipped') {
      expect(result.commands).toEqual([
        { command: 'npm ci', exitCode: 0, tail: 'one\ntwo' },
        { command: 'npm test', exitCode: 0, tail: 'partial' },
      ]);
    }
  });

  it('prepares the registry network for install only', async () => {
    const { service, sandbox } = setup([]);
    await service.run(input(makeRepo(manifest({ install: undefined }))));
    expect(sandbox.ensureNetwork).not.toHaveBeenCalled();
    const withInstall = setup([]);
    await withInstall.service.run(input(makeRepo(manifest())));
    expect(withInstall.sandbox.ensureNetwork).toHaveBeenCalledWith('swarmloop-registry', false);
  });

  it('lists a lockfile that install rewrote and does not call it an error', async () => {
    const repo = makeRepo(manifest());
    const { service } = setup([{ effect: () => writeFiles(repo, { 'package-lock.json': '{"lock":2}\n' }) }, {}]);
    const result = await service.run(input(repo));
    expect(result).toMatchObject({ status: 'ok', installChanged: ['package-lock.json'] });
  });

  it('lists a lockfile the agent had already edited only when install changes it again', async () => {
    const repo = makeRepo(manifest());
    writeFiles(repo, {
      'package.json': '{"name":"x","dependencies":{"a":"1"}}\n',
      'package-lock.json': '{"lock":3}\n',
    });
    const untouched = setup([{}, {}]);
    expect(await untouched.service.run(input(repo))).toMatchObject({ status: 'ok', installChanged: [] });
    const rewritten = setup([{ effect: () => writeFiles(repo, { 'package-lock.json': '{"lock":4}\n' }) }, {}]);
    expect(await rewritten.service.run(input(repo))).toMatchObject({ installChanged: ['package-lock.json'] });
  });

  it('stops at the first failing command and names it', async () => {
    const repo = makeRepo(manifest({ install: undefined, verify: ['first', 'second', 'third'] }));
    const { service, spawnDocker } = setup([{}, { code: 2, stderr: 'boom\n' }, {}]);
    const result = await service.run(input(repo));
    expect(commandsRun(spawnDocker)).toEqual(['first', 'second']);
    expect(result).toMatchObject({ status: 'failed', message: 'second exited 2' });
    if (result.status !== 'skipped') {
      expect(result.commands.map((entry) => [entry.command, entry.exitCode])).toEqual([
        ['first', 0],
        ['second', 2],
      ]);
      expect(result.commands[1]?.tail).toBe('boom');
    }
  });

  it('keeps only the last 150 lines of the tail', async () => {
    const repo = makeRepo(manifest({ install: undefined }));
    const output = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const { service } = setup([{ stdout: `${output}\n` }]);
    const result = await service.run(input(repo));
    const tail = result.status === 'skipped' ? '' : (result.commands[0]?.tail ?? '');
    expect(tail.split('\n')).toHaveLength(150);
    expect(tail.startsWith('line 50\n')).toBe(true);
  });

  it('returns error when a command runs past timeoutMin', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const repo = makeRepo(manifest({ install: undefined, timeoutMin: 2 }));
    const { service, spawnDocker, sandbox } = setup([{ hang: true }]);
    const running = service.run(input(repo));
    while (spawnDocker.mock.calls.length === 0) {
      await new Promise((done) => setImmediate(done));
    }
    jest.advanceTimersByTime(2 * 60_000);
    const result = await running;
    expect(result).toMatchObject({ status: 'error', message: 'verify timed out after 2 min' });
    expect(sandbox.kill).toHaveBeenCalledWith('swarmloop-r1-verify');
  });

  it('keeps error when the killed container closes before the kill call returns', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const repo = makeRepo(manifest({ install: undefined, timeoutMin: 2 }));
    const { service, spawnDocker } = setup([{ hang: true, closeOnKill: 137 }]);
    const running = service.run(input(repo));
    while (spawnDocker.mock.calls.length === 0) {
      await new Promise((done) => setImmediate(done));
    }
    jest.advanceTimersByTime(2 * 60_000);
    expect(await running).toMatchObject({ status: 'error', message: 'verify timed out after 2 min' });
  });

  it('keeps error when an abort kills the container and it closes first', async () => {
    const repo = makeRepo(manifest({ install: undefined }));
    const { service, spawnDocker } = setup([{ hang: true, closeOnKill: 137 }]);
    const abort = new AbortController();
    const running = service.run(input(repo, { signal: abort.signal }));
    while (spawnDocker.mock.calls.length === 0) {
      await new Promise((done) => setImmediate(done));
    }
    abort.abort();
    expect(await running).toMatchObject({ status: 'error', message: 'verify was stopped' });
  });

  it('returns error without starting a container when the run was stopped', async () => {
    const repo = makeRepo(manifest());
    const { service, spawnDocker } = setup([]);
    const result = await service.run(input(repo, { signal: AbortSignal.abort() }));
    expect(result).toMatchObject({ status: 'error', message: 'verify was stopped' });
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it('fails when a command leaves a file that git does not ignore', async () => {
    const repo = makeRepo(manifest({ install: undefined }));
    const { service } = setup([{ effect: () => writeFiles(repo, { 'out/report.txt': 'x', 'data/ok.txt': 'x' }) }]);
    const result = await service.run(input(repo));
    expect(result).toMatchObject({
      status: 'failed',
      message: 'verify created files that git does not ignore: out/report.txt; add them to .gitignore',
    });
  });

  it('does not blame a file the worktree already had', async () => {
    const repo = makeRepo(manifest({ install: undefined }));
    writeFiles(repo, { 'notes.txt': 'agent work' });
    const { service } = setup([{}]);
    expect(await service.run(input(repo))).toMatchObject({ status: 'ok' });
  });

  it('keeps an error status and appends the untracked-files text', async () => {
    const repo = makeRepo(manifest({ install: undefined }));
    const { service } = setup([{ code: 1, effect: () => writeFiles(repo, { 'junk.txt': 'x' }) }]);
    const result = await service.run(input(repo));
    expect(result).toMatchObject({
      status: 'failed',
      message: 'npm test exited 1; verify created files that git does not ignore: junk.txt; add them to .gitignore',
    });
  });

  it('reads the manifest from the base ref even when the worktree has another', async () => {
    const repo = makeRepo(manifest({ install: undefined, verify: ['from-base'] }));
    writeFileSync(join(repo, '.swarmloop.json'), JSON.stringify({ version: 1, image: 'x', verify: ['from-worktree'] }));
    const { service, spawnDocker } = setup([{}]);
    const result = await service.run(input(repo));
    expect(commandsRun(spawnDocker)).toEqual(['from-base']);
    expect(result).toMatchObject({ status: 'ok' });
  });

  it('reports an invalid manifest as error with the key', async () => {
    const repo = makeRepo(manifest({ verify: [] }));
    const { service, spawnDocker } = setup([]);
    const result = await service.run(input(repo));
    expect(result).toMatchObject({ status: 'error' });
    expect(result.status !== 'skipped' && result.message).toContain('"verify" must contain at least 1 items');
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it('reports an unknown key as a warning', async () => {
    const repo = makeRepo(manifest({ install: undefined, registries: ['x'] }));
    const { service } = setup([{}]);
    const result = await service.run(input(repo));
    expect(result).toMatchObject({ status: 'ok', warnings: ['unknown key "registries" ignored'] });
  });

  it('reports a failed image resolve as error', async () => {
    const repo = makeRepo(manifest({ install: undefined }));
    const { service, sandbox, spawnDocker } = setup([]);
    sandbox.run.mockRejectedValue(new Error('docker is down'));
    const result = await service.run(input(repo));
    expect(result).toMatchObject({ status: 'error', message: 'image node:22 cannot be pulled: docker is down' });
    expect(spawnDocker).not.toHaveBeenCalled();
  });
});

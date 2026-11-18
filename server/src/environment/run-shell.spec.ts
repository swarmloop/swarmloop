import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { checkOutputPath } from '../core/check-output';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';
import { runShell, type ShellDeps } from './run-shell';

const COMMAND = 'npm test';

function world(printed: number) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-shell-'));
  const sandbox = {
    stats: jest.fn().mockResolvedValue({ cpuPercent: 1, rssBytes: 1024 }),
    kill: jest.fn().mockResolvedValue(undefined),
    spawn: jest.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        containerName: 'swarmloop-shell',
      });
      setImmediate(() => {
        child.stdout.write(Array.from({ length: printed }, (_, i) => `out ${i}\n`).join(''));
        setImmediate(() => child.emit('close', 0));
      });
      return Promise.resolve(child);
    }),
  };
  const deps = { root, clock: new FakeClock(), sandbox } as unknown as ShellDeps;
  const input = {
    run: { activeAttempt: 'attempt-1' } as RunEntity,
    key: 'r1',
    step: 'implement',
    mounts: [],
    runtime: 'claude',
  } as unknown as Parameters<typeof runShell>[1];
  const mount = { hostPath: '/somewhere/repo', containerPath: '/work/repo' };
  const launch = {} as ProjectLaunch;
  return { root, deps, input, mount, launch };
}

const fileLines = (file: string) => readFileSync(file, 'utf8').trimEnd().split('\n');

describe('runShell', () => {
  it('returns the last 80 lines of a check with a mark, and its file holds all 500 lines', async () => {
    const w = world(498);
    const file = checkOutputPath(w.root, 'r1', 'implement', 'attempt-1', 0);

    const result = await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'checks', { index: 0, file });

    const all = fileLines(file);
    expect(all).toHaveLength(500);
    const [mark, ...rest] = result.tail.split('\n');
    expect(mark).toBe(
      '… 420 earlier lines not shown; the whole output: /work/logs/implement-attempt-1-command-0-log.txt',
    );
    expect(rest).toEqual(all.slice(-80));
  });

  it('marks the container of a setup and of a check as one whose result the server cannot read later', async () => {
    const w = world(1);
    const file = checkOutputPath(w.root, 'r1', 'implement', 'attempt-1', 0);

    await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'setup');
    await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'checks', { index: 0, file });

    const launches = (w.deps.sandbox.spawn as jest.Mock).mock.calls.map(([given]) => given);
    expect(launches).toHaveLength(2);
    expect(launches).toEqual([
      expect.objectContaining({ resultLost: true }),
      expect.objectContaining({ resultLost: true }),
    ]);
  });

  it('tells the sandbox whether a container is a setup or a check', async () => {
    const w = world(1);
    const file = checkOutputPath(w.root, 'r1', 'implement', 'attempt-1', 0);

    await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'setup');
    await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'checks', { index: 0, file });

    const held = (w.deps.sandbox.spawn as jest.Mock).mock.calls.map(([, given]) => given.work);
    expect(held).toEqual(['setup', 'check']);
  });

  it('gives a setup the same tail, mark and whole file', async () => {
    const w = world(498);

    const result = await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'setup');

    const names = readdirSync(join(w.root, 'data', 'run-logs', 'r1'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^implement-attempt-1-setup-repo-[0-9a-f]{8}-log\.txt$/);
    const all = fileLines(join(w.root, 'data', 'run-logs', 'r1', names[0]));
    expect(all).toHaveLength(500);
    const [mark, ...rest] = result.tail.split('\n');
    expect(mark).toBe(`… 420 earlier lines not shown; the whole output: /work/logs/${names[0]}`);
    expect(rest).toEqual(all.slice(-80));
    expect(existsSync(join(w.root, 'data', 'r1-setup-output.txt'))).toBe(true);
  });

  it('adds no mark to a short output', async () => {
    const w = world(3);
    const file = checkOutputPath(w.root, 'r1', 'implement', 'attempt-1', 0);

    const result = await runShell(w.deps, w.input, w.launch, COMMAND, w.mount, 'checks', { index: 0, file });

    expect(result.tail).toBe(['$ npm test', 'out 0', 'out 1', 'out 2', 'exit 0'].join('\n'));
  });
});

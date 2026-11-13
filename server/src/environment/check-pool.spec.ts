import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { SwarmloopError } from '../core/swarmloop-error';
import type { CheckCommandEntity, RunEntity } from '../history/entities';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { CheckPool } from './check-pool';
import type { CheckedRepo, EnvironmentInput } from './environment-types';
import { RequiredCheckFailed } from './project-environments';

const GB = 1024 ** 3;

function setup(options: {
  exits: (command: string, launch: SandboxLaunch, attempt: number) => number;
  capacity?: number;
  halted?: () => boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-pool-'));
  const spawned: SandboxLaunch[] = [];
  const attempts = new Map<string, number>();
  const alive = { now: 0, max: 0 };
  const sandbox = {
    stats: jest.fn().mockResolvedValue({ cpuPercent: 5, rssBytes: 1024 }),
    kill: jest.fn().mockResolvedValue(undefined),
    snapshot: jest.fn(() => ({ capacityMemoryBytes: options.capacity ?? 16 * GB })),
    spawn: jest.fn((launch: SandboxLaunch) => {
      spawned.push(launch);
      const command = launch.project?.shell ?? '';
      const attempt = (attempts.get(command) ?? 0) + 1;
      attempts.set(command, attempt);
      alive.now += 1;
      alive.max = Math.max(alive.max, alive.now);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        containerName: 'swarmloop-pool',
        memoryCapBytes: launch.memoryCapBytes ?? 4 * GB,
      });
      setImmediate(() => {
        child.stdout.write(`output of ${command} #${attempt}\n`);
        setImmediate(() => {
          alive.now -= 1;
          child.emit('close', options.exits(command, launch, attempt));
        });
      });
      return Promise.resolve(child);
    }),
  };
  const stored: { kind: string; body: string }[] = [];
  const documents = {
    putDocument: jest.fn((_run: RunEntity, kind: string, body: string) => {
      stored.push({ kind, body });
      return Promise.resolve();
    }),
  };
  const commands = { save: jest.fn((row: CheckCommandEntity) => Promise.resolve(row)) };
  const clock = new FakeClock();
  const pool = new CheckPool({
    checksParallel: () => 2,
    clock,
    sandbox: sandbox as unknown as ConstructorParameters<typeof CheckPool>[0]['sandbox'],
    documents,
    commands,
    shell: () => ({
      root,
      clock,
      sandbox: sandbox as unknown as ReturnType<ConstructorParameters<typeof CheckPool>[0]['shell']>['sandbox'],
      halted: options.halted,
    }),
  });
  const input = {
    run: {} as RunEntity,
    key: 'r1',
    step: 'checks',
    mounts: [],
    runtime: 'codex' as const,
  } as EnvironmentInput;
  const repoOf = (names: string[]): CheckedRepo => {
    const rows = names.map((name, index) => ({ commandIndex: index, command: name, name }) as CheckCommandEntity);
    return {
      mount: { hostPath: join(root, 'repo'), containerPath: '/work' },
      prepared: { launch: { image: 'img' }, record: { repo: 'repo' } },
      fingerprint: 'f',
      rows,
      results: [],
    } as unknown as CheckedRepo;
  };
  const checkDocuments = () => stored.filter((item) => item.kind === 'checks').map((item) => JSON.parse(item.body));
  return { pool, input, repoOf, spawned, checkDocuments, alive };
}

const killedFirst = (name: string) => (command: string, _launch: SandboxLaunch, attempt: number) =>
  command === name && attempt === 1 ? 137 : 0;

describe('CheckPool', () => {
  it('runs a check killed by its memory cap once more alone with the budget memory', async () => {
    const { pool, input, repoOf, spawned } = setup({ exits: killedFirst('b') });
    await pool.runAll(input, 'a1', [repoOf(['a', 'b'])]);
    const second = spawned.filter((launch) => launch.project?.shell === 'b');
    expect(second).toHaveLength(2);
    expect(second[0].alone).toBeUndefined();
    expect(second[1]).toMatchObject({ alone: true, memoryCapBytes: 16 * GB });
  });

  it('never gives the retry less than the seed when the budget has no memory limit', async () => {
    const { pool, input, repoOf, spawned } = setup({ exits: killedFirst('a'), capacity: 0 });
    await pool.runAll(input, 'a1', [repoOf(['a'])]);
    expect(spawned[1].memoryCapBytes).toBe(4 * GB);
  });

  it('counts a pass on the retry as passed and keeps the other checks in order', async () => {
    const { pool, input, repoOf, checkDocuments } = setup({ exits: killedFirst('b') });
    const repo = repoOf(['a', 'b', 'c']);
    await pool.runAll(input, 'a1', [repo]);
    expect(repo.results.map((result) => result?.exitCode)).toEqual([0, 0, 0]);
    expect(repo.results[1]?.tail).toContain('output of b #2');
    expect(repo.rows.map((row) => row.status)).toEqual(['passed', 'passed', 'passed']);
    expect(
      checkDocuments()
        .map((document) => document.command)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
    expect(checkDocuments().every((document) => !('outOfMemoryBytes' in document))).toBe(true);
  });

  it('fails the row and throws an environment error when the retry is killed again', async () => {
    const { pool, input, repoOf, checkDocuments } = setup({
      exits: (command) => (command === 'b' ? 137 : 0),
      capacity: 6 * GB,
    });
    const repo = repoOf(['a', 'b', 'c']);
    const error = await pool.runAll(input, 'a1', [repo]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SwarmloopError);
    expect(error).not.toBeInstanceOf(RequiredCheckFailed);
    expect(error).toMatchObject({
      category: 'environment',
      message: 'repo b ran out of memory at 6 GB: give Docker more memory or lower RESERVE_MEMORY_GB',
    });
    expect(repo.rows.map((row) => [row.status, row.exitCode])).toEqual([
      ['passed', 0],
      ['failed', 137],
      ['passed', 0],
    ]);
    expect(checkDocuments().find((document) => document.command === 'b')).toMatchObject({
      exitCode: 137,
      tail: 'ran out of memory at 6 GB',
    });
    expect(repo.results[0]?.tail).toContain('output of a #1');
    expect(repo.results[2]?.tail).toContain('output of c #1');
  });

  it('does not retry a timeout or an ordinary failure', async () => {
    const { pool, input, repoOf, spawned } = setup({ exits: (command) => (command === 'a' ? 124 : 1) });
    const repo = repoOf(['a', 'b']);
    await pool.runAll(input, 'a1', [repo]);
    expect(spawned).toHaveLength(2);
    expect(repo.results.map((result) => result?.exitCode)).toEqual([124, 1]);
  });

  it('does not take a kill by a Stop for a memory kill and starts no new container', async () => {
    const { pool, input, repoOf, spawned } = setup({ exits: () => 137, halted: () => true });
    const repo = repoOf(['a']);
    await pool.runAll(input, 'a1', [repo]);
    expect(spawned).toHaveLength(1);
    expect(repo.results[0]).toMatchObject({ exitCode: 137 });
    expect(repo.results[0]?.tail).not.toContain('ran out of memory');
  });

  it('never has more check containers alive than CHECKS_PARALLEL during a retry', async () => {
    const { pool, input, repoOf, alive, spawned } = setup({
      exits: (_command, _launch, attempt) => (attempt === 1 ? 137 : 0),
    });
    await pool.runAll(input, 'a1', [repoOf(['a', 'b', 'c', 'd', 'e'])]);
    expect(spawned).toHaveLength(10);
    expect(alive.max).toBe(2);
  });
});

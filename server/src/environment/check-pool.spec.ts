import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { SwarmloopError } from '../core/swarmloop-error';
import type { CheckCommandEntity, RunEntity } from '../history/entities';
import type { SampleDraft } from '../history/visit';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { CheckPool, ChecksStopped } from './check-pool';
import type { CheckedRepo, EnvironmentInput } from './environment-types';
import { LiveHub } from '../live/live.hub';
import { RequiredCheckFailed } from './project-environments';

const GB = 1024 ** 3;

function setup(options: {
  exits: (command: string, launch: SandboxLaunch, attempt: number) => number;
  /** The fixed memory cap every container of the fake sandbox carries. */
  cap?: number;
  halted?: () => boolean;
  /** The Stop intent the line reads when a command asks for a place. */
  stopped?: (key: string) => boolean;
  live?: LiveHub;
  /** The CHECKS_PARALLEL value, read each time a command asks for a place. */
  limit?: { value: number };
  /** How far the fake clock moves each time a container ends. */
  tick?: number;
  samples?: SampleDraft[];
}) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-pool-'));
  const spawned: SandboxLaunch[] = [];
  const attempts = new Map<string, number>();
  const alive = { now: 0, max: 0 };
  const sandbox = {
    stats: jest.fn().mockResolvedValue({ cpuPercent: 5, rssBytes: 1024 }),
    kill: jest.fn().mockResolvedValue(undefined),
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
        memoryCapBytes: options.cap ?? 4 * GB,
      });
      setImmediate(() => {
        child.stdout.write(`output of ${command} #${attempt}\n`);
        setImmediate(() => {
          alive.now -= 1;
          clock.advance(options.tick ?? 0);
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
  const logs: { key: string; step: string; command?: number; body: string; samples?: unknown[] }[] = [];
  const limit = options.limit ?? { value: 2 };
  const pool = new CheckPool({
    checksParallel: () => limit.value,
    halted: options.stopped,
    clock,
    documents,
    commands,
    live: options.live ?? { changed: () => undefined, log: (entry) => void logs.push(entry) },
    shell: () => ({
      root,
      clock,
      sandbox: sandbox as unknown as ReturnType<ConstructorParameters<typeof CheckPool>[0]['shell']>['sandbox'],
      halted: options.halted,
    }),
  });
  const inputOf = (key: string) =>
    ({
      run: {} as RunEntity,
      key,
      step: 'checks',
      mounts: [],
      runtime: 'codex' as const,
      samples: options.samples,
    }) as EnvironmentInput;
  const input = inputOf('r1');
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
  return { pool, input, inputOf, repoOf, spawned, checkDocuments, alive, logs };
}

const killedFirst = (name: string) => (command: string, _launch: SandboxLaunch, attempt: number) =>
  command === name && attempt === 1 ? 137 : 0;

describe('CheckPool', () => {
  it('runs a check killed by its memory cap once more under the same cap, and reports no kill when it passes', async () => {
    const { pool, input, repoOf, spawned } = setup({ exits: killedFirst('b') });
    await pool.runAll(input, 'a1', [repoOf(['a', 'b'])]);
    const second = spawned.filter((launch) => launch.project?.shell === 'b');
    expect(second).toHaveLength(2);
    expect(second[1]).toEqual(second[0]);
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
      cap: 6 * GB,
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
    const { pool, inputOf, repoOf, alive, spawned } = setup({
      exits: (_command, _launch, attempt) => (attempt === 1 ? 137 : 0),
    });
    await Promise.all([
      pool.runAll(inputOf('r1'), 'a1', [repoOf(['a', 'b', 'c', 'd', 'e'])]),
      pool.runAll(inputOf('r2'), 'a2', [repoOf(['f', 'g', 'h', 'i', 'j'])]),
    ]);
    expect(spawned).toHaveLength(20);
    expect(alive.max).toBe(2);
  });

  it('runs the commands of two runs in one line of CHECKS_PARALLEL places', async () => {
    const { pool, inputOf, repoOf, alive, spawned } = setup({ exits: () => 0, limit: { value: 3 } });
    const first = repoOf(['a1', 'b1', 'c1']);
    const second = repoOf(['a2', 'b2', 'c2']);
    await Promise.all([pool.runAll(inputOf('r1'), 'a1', [first]), pool.runAll(inputOf('r2'), 'a2', [second])]);
    expect(alive.max).toBe(3);
    expect(spawned).toHaveLength(6);
    expect(first.results.map((result) => result?.tail)).toEqual([
      expect.stringContaining('output of a1'),
      expect.stringContaining('output of b1'),
      expect.stringContaining('output of c1'),
    ]);
    expect(second.results.map((result) => result?.tail)).toEqual([
      expect.stringContaining('output of a2'),
      expect.stringContaining('output of b2'),
      expect.stringContaining('output of c2'),
    ]);
  });

  it('shows a waiting command its place in the line and starts it when a place frees', async () => {
    const samples = [
      { sampledAt: '2026-01-01T00:00:00.000Z', cpuPercent: 7, rssBytes: 2048, source: '0' },
    ] as SampleDraft[];
    const { pool, input, repoOf, logs } = setup({ exits: () => 0, limit: { value: 1 }, tick: 1000, samples });
    const repo = repoOf(['a', 'b', 'c']);
    const queued = Date.UTC(2026, 0, 1);
    await pool.runAll(input, 'a1', [repo]);
    const waiting = logs.filter((entry) => entry.body.startsWith('waiting for a free check slot'));
    expect(waiting.filter((entry) => entry.command === 2).map((entry) => entry.body)).toEqual([
      'waiting for a free check slot (1 ahead)\n',
      'waiting for a free check slot (0 ahead)\n',
    ]);
    expect(waiting[0]?.samples).toEqual([{ at: '2026-01-01T00:00:00.000Z', cpu: 7, memory: 2048, source: '0' }]);
    expect(repo.results).toHaveLength(3);
    expect(repo.rows.map((row) => row.startedAt)).toEqual(
      [0, 1000, 2000].map((ms) => new Date(queued + ms).toISOString()),
    );
  });

  it('takes the waiting commands of a stopped run out of the line', async () => {
    const { pool, inputOf, repoOf, spawned } = setup({ exits: () => 0, limit: { value: 1 } });
    const stopped = pool.runAll(inputOf('r1'), 'a1', [repoOf(['a1', 'b1', 'c1'])]);
    const other = repoOf(['a2', 'b2', 'c2']);
    const kept = pool.runAll(inputOf('r2'), 'a2', [other]);
    pool.stopWaiting('r1');
    await expect(stopped).rejects.toBeInstanceOf(ChecksStopped);
    await kept;
    expect(spawned.map((launch) => launch.project?.shell).sort()).toEqual(['a1', 'a2', 'b2', 'c2']);
    expect(other.results).toHaveLength(3);
  });

  it('reads CHECKS_PARALLEL when a command asks for a place', async () => {
    const limit = { value: 1 };
    const { pool, inputOf, repoOf } = setup({ exits: () => 0, limit, tick: 1000 });
    const repo = repoOf(['a', 'b', 'c']);
    const first = pool.runAll(inputOf('r1'), 'a1', [repo]);
    limit.value = 2;
    const second = pool.runAll(inputOf('r2'), 'a2', [repoOf(['d'])]);
    await Promise.all([first, second]);
    expect(repo.rows[1]?.startedAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
  });

  it('starts no container for a run that is already stopped when its command asks for a place', async () => {
    const { pool, inputOf, repoOf, spawned } = setup({ exits: () => 0, stopped: (key) => key === 'r1' });
    const stopped = expect(pool.runAll(inputOf('r1'), 'a1', [repoOf(['a1', 'b1'])])).rejects.toBeInstanceOf(
      ChecksStopped,
    );
    const other = repoOf(['a2']);
    await pool.runAll(inputOf('r2'), 'a2', [other]);
    await stopped;
    expect(spawned.map((launch) => launch.project?.shell)).toEqual(['a2']);
    expect(other.results).toHaveLength(1);
  });

  it('runs a rerun command in the same line', async () => {
    const { pool, input } = setup({ exits: () => 0, limit: { value: 1 } });
    let finish: () => void = () => undefined;
    const events: string[] = [];
    const first = pool.withPlace(
      input,
      () => undefined,
      () => new Promise<void>((resolve) => (finish = resolve)).then(() => void events.push('first done')),
    );
    const second = pool.withPlace(
      input,
      (ahead) => void events.push(`waits ${ahead} ahead`),
      () => Promise.resolve().then(() => void events.push('second ran')),
    );
    await Promise.resolve();
    expect(events).toEqual(['waits 0 ahead']);
    finish();
    await Promise.all([first, second]);
    expect(events).toEqual(['waits 0 ahead', 'first done', 'second ran']);
  });

  it('tells the live hub on every row change, so a window sees running and then passed', async () => {
    const live = new LiveHub();
    const { pool, input, repoOf } = setup({ exits: () => 0, live });
    const repo = repoOf(['a']);
    const seen: string[] = [];
    live.onChanged((key) => seen.push(`${key}:${repo.rows[0].status}`));
    await pool.runAll(input, 'a1', [repo]);
    expect(seen).toEqual(['r1:undefined', 'r1:running', 'r1:passed']);
  });
});

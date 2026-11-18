import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type * as DiskGuard from './disk-guard';
import { treeBytes } from './disk-guard';
import { OwnUseMeter } from './own-use-meter';

function actualGuard(): typeof DiskGuard {
  return jest.requireActual<typeof DiskGuard>('./disk-guard');
}

jest.mock('./disk-guard', () => ({ ...actualGuard(), treeBytes: jest.fn(actualGuard().treeBytes) }));

const walkTree = jest.mocked(treeBytes);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OwnUseMeter', () => {
  let home: string;
  let clock: FakeClock;
  let meter: OwnUseMeter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'meter-'));
    mkdirSync(join(home, 'data'));
    mkdirSync(join(home, 'worktrees'));
    clock = new FakeClock();
    meter = new OwnUseMeter(new AppConfig(testEnv({ SWARMLOOP_ROOT: home })), clock);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('has nothing before the first measure', () => {
    expect(meter.last()).toBeNull();
  });

  it('lists worktrees, logs, backups and the environment cache with the time of the measure', async () => {
    mkdirSync(join(home, 'worktrees', 'run-1'));
    writeFileSync(join(home, 'worktrees', 'run-1', 'file'), Buffer.alloc(2048));
    writeFileSync(join(home, 'data', 'run-1-implement-output.txt'), Buffer.alloc(1024));
    mkdirSync(join(home, 'data', 'backups'));
    writeFileSync(join(home, 'data', 'backups', 'swarmloop-x.sqlite.gz'), Buffer.alloc(3 * 1024 * 1024));

    await meter.measure();

    expect(meter.last()).toEqual({
      line: 'swarmloop uses worktrees 2.0 KB, logs 1.0 KB, backups 3.0 MB, environment cache 0 B',
      at: clock.now(),
    });
  });

  it('counts the logs in the run log folders with the other logs', async () => {
    writeFileSync(join(home, 'data', 'run-1-implement-output.txt'), Buffer.alloc(1024));
    mkdirSync(join(home, 'data', 'run-logs', 'run-1'), { recursive: true });
    writeFileSync(join(home, 'data', 'run-logs', 'run-1', 'implement-a-command-0-log.txt'), Buffer.alloc(2048));

    await meter.measure();

    expect(meter.last()?.line).toContain('logs 3.0 KB');
  });

  it('shares the walk in progress with a second measure, and measures anew after it', async () => {
    const gate = deferred();
    walkTree.mockImplementationOnce(async (path) => {
      await gate.promise;
      return actualGuard().treeBytes(path);
    });
    const first = meter.measure();
    const second = meter.measure();
    writeFileSync(join(home, 'worktrees', 'late'), Buffer.alloc(4096));

    expect(second).toBe(first);
    expect(meter.last()).toBeNull();

    gate.resolve();
    await Promise.all([first, second]);

    expect(meter.last()).toEqual({ line: expect.stringContaining('worktrees 4.0 KB'), at: clock.now() });

    writeFileSync(join(home, 'worktrees', 'later'), Buffer.alloc(4096));
    clock.advance(1000);
    await meter.measure();

    expect(meter.last()).toEqual({ line: expect.stringContaining('worktrees 8.0 KB'), at: clock.now() });
  });

  it('keeps the last result when a walk fails, and the next measure walks again', async () => {
    await meter.measure();
    const saved = meter.last();
    walkTree.mockRejectedValueOnce(new Error('unreadable'));

    await expect(meter.measure()).rejects.toThrow('unreadable');
    expect(meter.last()).toEqual(saved);

    writeFileSync(join(home, 'worktrees', 'late'), Buffer.alloc(4096));
    clock.advance(1000);
    await meter.measure();

    expect(meter.last()).toEqual({ line: expect.stringContaining('worktrees 4.0 KB'), at: clock.now() });
  });

  it('measures again after a walk ended', async () => {
    await meter.measure();
    writeFileSync(join(home, 'worktrees', 'late'), Buffer.alloc(4096));
    clock.advance(1000);

    await meter.measure();

    expect(meter.last()).toMatchObject({ line: expect.stringContaining('worktrees 4.0 KB'), at: clock.now() });
  });
});

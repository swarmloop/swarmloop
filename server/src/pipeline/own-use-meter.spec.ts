import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { OwnUseMeter } from './own-use-meter';

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

  it('does nothing for a second measure during a walk', async () => {
    const first = meter.measure();
    writeFileSync(join(home, 'worktrees', 'late'), Buffer.alloc(4096));
    await meter.measure();
    expect(meter.last()).toBeNull();

    await first;

    expect(meter.last()?.line).toContain('worktrees');
  });

  it('measures again after a walk ended', async () => {
    await meter.measure();
    writeFileSync(join(home, 'worktrees', 'late'), Buffer.alloc(4096));
    clock.advance(1000);

    await meter.measure();

    expect(meter.last()).toMatchObject({ line: expect.stringContaining('worktrees 4.0 KB'), at: clock.now() });
  });
});

import 'reflect-metadata';
import { existsSync } from 'fs';
import { AppConfig } from '../config/env';
import { ERROR_CODES } from '../contract/error-codes';
import { dfAvailableBytes } from '../core/free-bytes';
import { SwarmloopError } from '../core/swarmloop-error';
import { SandboxService } from '../sandbox/sandbox.service';
import { DiskGuard } from './disk-guard';
import { ageRun, freshRun, leaveFiles, makeWorld, seedRun, type World } from './workspace.spec-helpers';

const GB = 1024 ** 3;

describe('DiskGuard', () => {
  let world: World;
  let docker: jest.Mock;

  async function setup(key: string): Promise<DiskGuard> {
    world = await makeWorld(key);
    docker = jest.fn(async () => '');
    world.app.get(SandboxService).useDocker(docker);
    world.app.get(AppConfig).env.MIN_FREE_GB = 10;
    return world.app.get(DiskGuard);
  }

  afterEach(async () => {
    await world.app.close();
  });

  it('lets a step start when enough disk is free', async () => {
    const guard = await setup('PROJ-1');
    guard.useFreeBytes(async () => 50 * GB);

    await expect(guard.check(await freshRun(world), 'implement')).resolves.toBeUndefined();

    expect(docker).not.toHaveBeenCalled();
  });

  it('cleans the oldest done run first and goes on once the disk has room', async () => {
    const guard = await setup('PROJ-2');
    await seedRun(world.app, 'PROJ-3', 'running', 0);
    await ageRun(world.app, 'PROJ-2', 'done', 2);
    const current = await seedRun(world.app, 'PROJ-4', 'waiting', 0);
    guard.useFreeBytes(async () => (existsSync(world.worktree) ? 2 * GB : 50 * GB));

    await guard.check(current, 'implement');

    expect(existsSync(world.worktree)).toBe(false);
    expect((await freshRun(world)).workspace).toBe('removed');
    expect(docker).not.toHaveBeenCalled();
  });

  it('prunes docker, then blocks with DISK_LOW and says what takes the space', async () => {
    const guard = await setup('PROJ-5');
    leaveFiles(world.swarm, 'PROJ-5');
    await ageRun(world.app, 'PROJ-5', 'done', 2);
    const current = await seedRun(world.app, 'PROJ-6', 'done', 30);
    guard.useFreeBytes(async () => 2 * GB);

    const error = await guard.check(current, 'implement').catch((caught: unknown) => caught as SwarmloopError);

    expect(error).toBeInstanceOf(SwarmloopError);
    expect((error as SwarmloopError).code).toBe(ERROR_CODES.DISK_LOW);
    for (const part of ['2.0 GB', 'MIN_FREE_GB=10', 'agent-state', 'worktrees', 'outputs', 'docker', 'implement']) {
      expect((error as SwarmloopError).message).toContain(part);
    }
    expect(existsSync(world.worktree)).toBe(false);
    expect((await freshRun(world)).workspace).toBe('removed');
    expect(docker.mock.calls.map((call) => call[0]).filter((args: string[]) => args[1] === 'prune')).toEqual([
      ['image', 'prune', '-f'],
      ['builder', 'prune', '-f', '--filter', 'until=24h'],
    ]);
  });

  it('never cleans the run that is about to start, and keeps everything when RETAIN_DONE_DAYS is 0', async () => {
    const guard = await setup('PROJ-7');
    const done = await ageRun(world.app, 'PROJ-7', 'done', 30);
    guard.useFreeBytes(async () => 2 * GB);

    await expect(guard.check(done, 'implement')).rejects.toMatchObject({ code: ERROR_CODES.DISK_LOW });
    expect(existsSync(world.worktree)).toBe(true);

    world.app.get(AppConfig).env.RETAIN_DONE_DAYS = 0;
    const other = await seedRun(world.app, 'PROJ-8', 'waiting', 0);
    await expect(guard.check(other, 'implement')).rejects.toMatchObject({ code: ERROR_CODES.DISK_LOW });
    expect(existsSync(world.worktree)).toBe(true);
  });

  it('prunes docker with exactly the dangling and 24 h filters, and not at all when DOCKER_PRUNE is off', async () => {
    const guard = await setup('PROJ-9');

    await guard.pruneDocker();
    expect(docker.mock.calls.map((call) => call[0])).toEqual([
      ['image', 'prune', '-f'],
      ['builder', 'prune', '-f', '--filter', 'until=24h'],
    ]);

    docker.mockClear();
    world.app.get(AppConfig).env.DOCKER_PRUNE = false;
    await guard.pruneDocker();
    expect(docker).not.toHaveBeenCalled();
  });

  it('logs a docker that fails and still tries the second prune', async () => {
    const guard = await setup('PROJ-10');
    docker.mockRejectedValueOnce(new Error('daemon down'));

    await expect(guard.pruneDocker()).resolves.toBeUndefined();

    expect(docker).toHaveBeenCalledTimes(2);
  });
});

describe('dfAvailableBytes', () => {
  it('reads the available column of df -Pk, whatever the filesystem name holds', () => {
    const output = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      '/proc/self/fd/3 482797652 462119252  20678400      96% /mnt/swarm loop',
    ].join('\n');
    expect(dfAvailableBytes(output)).toBe(20678400 * 1024);
    expect(dfAvailableBytes('grpcfuse with spaces 100 40 60 40% /app/data')).toBe(60 * 1024);
  });

  it('returns null for output it does not know', () => {
    expect(dfAvailableBytes('df: /nope: No such file or directory')).toBeNull();
  });
});

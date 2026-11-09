import 'reflect-metadata';
import { existsSync } from 'fs';
import { AppConfig } from '../config/env';
import { ERROR_CODES } from '../contract/error-codes';
import { SwarmloopError } from '../core/swarmloop-error';
import { DocumentRepository } from '../history/document.repository';
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

  it('keeps the dangling image of a run that is not done and removes the others', async () => {
    const guard = await setup('PROJ-11');
    const running = await seedRun(world.app, 'PROJ-12', 'running', 0);
    const finished = await seedRun(world.app, 'PROJ-13', 'done', 0);
    const images = (id: string) =>
      JSON.stringify({ agent: { ref: `agent:${id}`, id: `sha256:${id}0000` }, egress: { ref: 'egress:1' } });
    const documents = world.app.get(DocumentRepository);
    await documents.putDocument(running, 'images', images('aaa111'));
    await documents.putDocument(finished, 'images', images('ccc333'));
    docker.mockImplementation(async (args: string[]) =>
      args[1] === 'ls' ? 'aaa111/<none>\nbbb222/<none>\nccc333/<none>\n' : '',
    );

    await guard.pruneDocker();

    const calls = docker.mock.calls.map((call) => call[0]);
    expect(calls.filter((args: string[]) => args[1] === 'rm')).toEqual([
      ['image', 'rm', 'bbb222'],
      ['image', 'rm', 'ccc333'],
    ]);
    expect(calls).not.toContainEqual(['image', 'prune', '-f']);
    expect(calls).toContainEqual(['builder', 'prune', '-f', '--filter', 'until=24h']);
  });

  it('goes on with the next dangling image when one cannot be removed', async () => {
    const guard = await setup('PROJ-14');
    const running = await seedRun(world.app, 'PROJ-15', 'running', 0);
    await world.app
      .get(DocumentRepository)
      .putDocument(running, 'images', JSON.stringify({ agent: { ref: 'a:1' }, egress: { ref: 'e:1' } }));
    docker.mockImplementation(async (args: string[]) => {
      if (args[1] === 'ls') return 'bbb222/<none>\nddd444/<none>\n';
      if (args[1] === 'rm' && args[2] === 'bbb222') throw new Error('image is in use');
      return '';
    });

    await guard.pruneDocker();

    expect(docker.mock.calls.map((call) => call[0])).toContainEqual(['image', 'rm', 'ddd444']);
  });

  it('logs a docker that fails and still tries the second prune', async () => {
    const guard = await setup('PROJ-10');
    docker.mockRejectedValueOnce(new Error('daemon down'));

    await expect(guard.pruneDocker()).resolves.toBeUndefined();

    expect(docker).toHaveBeenCalledTimes(2);
  });
});

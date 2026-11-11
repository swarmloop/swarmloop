import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RunEntity } from '../history/entities';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { checkOutputPath } from '../core/check-output';
import { RunRetention } from './run-retention';
import { ageRun, clean, freshRun, leaveFiles, makeWorld, seedRun, type World } from './workspace.spec-helpers';
import { git } from '../steps/prepare/prepare.step.spec-helpers';
import { WorkspaceGuard } from './workspace-guard';

const age = (world: World, days: number, status = 'done') => ageRun(world.app, world.key, status, days);

describe('RunRetention', () => {
  let world: World;

  afterEach(async () => {
    await world.app.close();
  });

  it('removes the worktree, agent state and outputs of an old done run, and keeps the rest', async () => {
    world = await makeWorld('PROJ-1');
    const files = leaveFiles(world.swarm, 'PROJ-1');
    await age(world, 10);

    const cleaned = await world.app.get(RunRetention).apply(3);

    expect(cleaned).toEqual(['PROJ-1']);
    expect(existsSync(world.worktree)).toBe(false);
    expect(existsSync(join(world.swarm, 'worktrees', 'PROJ-1'))).toBe(false);
    expect(existsSync(files.state)).toBe(false);
    expect(existsSync(files.output)).toBe(false);
    expect(existsSync(files.session)).toBe(true);
    expect(git(world.clone, ['rev-parse', '--verify', world.branch])).toBe(world.sha);
    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).not.toContain(world.worktree);
    expect((await freshRun(world)).workspace).toBe('removed');
  });

  it('removes the output files of the check commands with the run, and not the files of another run', async () => {
    world = await makeWorld('PROJ-1');
    const mine = checkOutputPath(world.swarm, 'PROJ-1', 'checks', 'attempt1', 3);
    const other = checkOutputPath(world.swarm, 'PROJ-1-sub', 'checks', 'attempt1', 3);
    mkdirSync(join(world.swarm, 'data'), { recursive: true });
    writeFileSync(mine, 'out\n');
    writeFileSync(other, 'out\n');
    await age(world, 10);

    await world.app.get(RunRetention).apply(3);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('leaves a done run younger than the threshold, and everything when the threshold is 0', async () => {
    world = await makeWorld('PROJ-2');
    await age(world, 1);

    expect(await world.app.get(RunRetention).apply(3)).toEqual([]);
    expect(await world.app.get(RunRetention).apply(0)).toEqual([]);

    expect(existsSync(world.worktree)).toBe(true);
    expect((await freshRun(world)).workspace).toBeNull();
  });

  it.each(['running', 'waiting', 'failed', 'blocked', 'stopped', 'idle'])(
    'never touches a run that is %s, however old',
    async (status) => {
      world = await makeWorld('PROJ-3');
      const files = leaveFiles(world.swarm, 'PROJ-3');
      await age(world, 100, status);
      const retention = world.app.get(RunRetention);

      expect(await retention.apply(1)).toEqual([]);
      expect(await retention.cleanOldest('other')).toBeNull();

      expect(existsSync(world.worktree)).toBe(true);
      expect(existsSync(files.state)).toBe(true);
      expect(existsSync(files.output)).toBe(true);
      expect((await freshRun(world)).workspace).toBeNull();
    },
  );

  it('removes the worktree of a merged run right away, keeps a closed one, and keeps all when the threshold is 0', async () => {
    world = await makeWorld('PROJ-10');
    await age(world, 0);
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-10' }, { state: 'closed' });
    expect(await world.app.get(RunRetention).apply(3)).toEqual([]);
    await table.update({ key: 'PROJ-10' }, { state: 'merged' });
    expect(await world.app.get(RunRetention).apply(0)).toEqual([]);

    expect(await world.app.get(RunRetention).apply(3)).toEqual(['PROJ-10']);

    expect(existsSync(world.worktree)).toBe(false);
    expect((await freshRun(world)).workspace).toBe('removed');
  });

  it("ages a done run by when the merge watch first saw it, not by the watch's later writes", async () => {
    world = await makeWorld('PROJ-11');
    await age(world, 10);
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await table.update({ key: 'PROJ-11' }, { doneAt: old, updatedAt: new Date().toISOString() });

    expect(await world.app.get(RunRetention).apply(3)).toEqual(['PROJ-11']);
  });

  it('cleans the oldest done run first and never the run it is told to skip', async () => {
    world = await makeWorld('PROJ-4');
    await age(world, 5);
    await seedRun(world.app, 'PROJ-5', 'done', 9);
    const retention = world.app.get(RunRetention);

    expect(await retention.cleanOldest('PROJ-5')).toBe('PROJ-4');
    expect(await retention.cleanOldest('PROJ-5')).toBeNull();
    expect(await retention.cleanOldest('PROJ-4')).toBe('PROJ-5');
  });

  it('lets a cleaned run come back on demand', async () => {
    world = await makeWorld('PROJ-6');
    await age(world, 10);
    await world.app.get(RunRetention).apply(3);

    await world.app.get(WorkspaceGuard).ensure(await freshRun(world));

    expect(existsSync(join(world.worktree, 'feature.txt'))).toBe(true);
    expect((await freshRun(world)).workspace).toBeNull();
  });

  it('cleans a done run whose row is from before `state` existed, by its status', async () => {
    world = await makeWorld('PROJ-8');
    await age(world, 10);
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-8' }, { state: null });

    expect(await world.app.get(RunRetention).apply(3)).toEqual(['PROJ-8']);
  });

  it('never cleans a run with no state that is not done', async () => {
    world = await makeWorld('PROJ-9');
    await age(world, 10, 'failed');
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-9' }, { state: null });

    expect(await world.app.get(RunRetention).apply(3)).toEqual([]);
    expect(existsSync(world.worktree)).toBe(true);
  });

  it('skips a run that was cleaned already', async () => {
    world = await makeWorld('PROJ-7');
    await age(world, 10);
    await clean(world);

    expect(await world.app.get(RunRetention).apply(3)).toEqual([]);
  });
});

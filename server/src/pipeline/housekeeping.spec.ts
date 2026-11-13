import 'reflect-metadata';
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import { git } from '../steps/prepare/prepare.step.spec-helpers';
import { Housekeeping } from './housekeeping';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RunEntity } from '../history/entities';
import { OwnUseMeter } from './own-use-meter';
import { RunRetention } from './run-retention';
import { ageRun, makeWorld, type World } from './workspace.spec-helpers';

describe('Housekeeping startup', () => {
  let world: World;

  afterEach(async () => {
    await world.app.close();
  });

  it('prunes a registration whose worktree is missing, even a locked one, and keeps the live ones', async () => {
    world = await makeWorld('PROJ-1');
    const gone = join(world.swarm, 'worktrees', 'PROJ-1', 'gone');
    git(world.clone, ['worktree', 'add', '--detach', gone, 'HEAD']);
    git(world.clone, ['worktree', 'lock', '--reason', 'swarmloop run PROJ-1', gone]);
    renameSync(gone, `${gone}-away`);

    await world.app.get(Housekeeping).startup();

    const listed = git(world.clone, ['worktree', 'list', '--porcelain']);
    expect(listed).not.toContain(`worktree ${gone}\n`);
    expect(listed).toContain(`worktree ${world.worktree}`);
  });

  it('locks a live registration that is unlocked, so a host prune leaves it alone', async () => {
    world = await makeWorld('PROJ-2');
    git(world.clone, ['worktree', 'unlock', world.worktree]);

    await world.app.get(Housekeeping).startup();

    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).toContain('locked swarmloop run PROJ-2');
  });

  it('applies retention to the runs that finished before, once', async () => {
    world = await makeWorld('PROJ-3');
    await ageRun(world.app, 'PROJ-3', 'done', 10);

    await world.app.get(Housekeeping).startup();

    expect(existsSync(world.worktree)).toBe(false);
    expect(existsSync(join(world.swarm, 'data', 'retention-catch-up'))).toBe(true);
  });

  it('does not repeat the catch-up on the next start', async () => {
    world = await makeWorld('PROJ-4');
    await world.app.get(Housekeeping).startup();
    await ageRun(world.app, 'PROJ-4', 'done', 10);

    await world.app.get(Housekeeping).startup();

    expect(existsSync(world.worktree)).toBe(true);
  });

  it('measures the sizes at startup, also when the catch-up already ran', async () => {
    world = await makeWorld('PROJ-6');
    await world.app.get(Housekeeping).startup();
    const meter = world.app.get(OwnUseMeter);
    const measure = jest.spyOn(meter, 'measure');

    await world.app.get(Housekeeping).startup();
    await measure.mock.results[0].value;

    expect(meter.last()?.line).toContain('swarmloop uses worktrees');
  });
});

describe('Housekeeping schedule', () => {
  let world: World;

  afterEach(async () => {
    jest.restoreAllMocks();
    await world.app.close();
  });

  it('frees a run that turned merged on the next scheduled pass', async () => {
    world = await makeWorld('PROJ-5');
    await ageRun(world.app, 'PROJ-5', 'done', 0);
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-5' }, { state: 'merged' });
    const intervals = jest.spyOn(global, 'setInterval');
    const apply = jest.spyOn(world.app.get(RunRetention), 'apply');
    const housekeeping = world.app.get(Housekeeping);

    housekeeping.schedule();
    const pass = intervals.mock.calls.find(([, delay]) => delay === 5 * 60_000)?.[0] as () => void;
    pass();
    await apply.mock.results[0].value;

    expect(existsSync(world.worktree)).toBe(false);
    housekeeping.onModuleDestroy();
  });

  it("measures the sizes every 10 minutes, in an unref'd timer that stop clears", async () => {
    world = await makeWorld('PROJ-7');
    const intervals = jest.spyOn(global, 'setInterval');
    const cleared = jest.spyOn(global, 'clearInterval');
    const measure = jest.spyOn(world.app.get(OwnUseMeter), 'measure');
    const housekeeping = world.app.get(Housekeeping);

    housekeeping.schedule();
    const index = intervals.mock.calls.findIndex(([, delay]) => delay === 10 * 60_000);
    expect(index).toBeGreaterThanOrEqual(0);
    intervals.mock.calls[index][0]();
    await measure.mock.results[0].value;
    expect(world.app.get(OwnUseMeter).last()).not.toBeNull();

    housekeeping.onModuleDestroy();
    expect(cleared).toHaveBeenCalledWith(intervals.mock.results[index].value);
  });
});

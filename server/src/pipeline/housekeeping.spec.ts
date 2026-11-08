import 'reflect-metadata';
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import { git } from '../steps/prepare/prepare.step.spec-helpers';
import { Housekeeping } from './housekeeping';
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
});

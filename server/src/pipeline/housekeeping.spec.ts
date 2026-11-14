import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { boot, git, repoWithMain } from '../steps/prepare/prepare.step.spec-helpers';
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

describe('Housekeeping startup checkouts log', () => {
  let app: TestingModule | undefined;
  let parent: string;
  let swarm: string;
  let lines: string[];
  let warnings: string[];

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'swarmloop-checkouts-'));
    swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    lines = [];
    warnings = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => void lines.push(String(message)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  async function start(checkoutsRoot: string, repos = ''): Promise<void> {
    app = await boot(swarm, checkoutsRoot, {}, repos);
    await app.get(Housekeeping).startup();
  }

  it('logs the folder and the allowed projects, sorted', async () => {
    repoWithMain(parent, 'zeta');
    repoWithMain(parent, 'alpha');
    await start('..');
    expect(lines).toContain(`checkouts in ${parent}: alpha, zeta`);
  });

  it('logs only the projects SWARMLOOP_REPOS allows', async () => {
    repoWithMain(parent, 'alpha');
    repoWithMain(parent, 'zeta');
    await start('..', 'zeta');
    expect(lines).toContain(`checkouts in ${parent}: zeta`);
  });

  it('logs none when the folder holds no git project', async () => {
    await start('..');
    expect(lines).toContain(`checkouts in ${parent}: none`);
  });

  it('warns naming a missing folder and still goes on to the tidy of registrations', async () => {
    const missing = join(parent, 'nowhere');
    await start(missing);
    expect(warnings.some((warning) => warning.includes(missing))).toBe(true);
    expect(warnings.some((warning) => warning.startsWith('worktree registrations were not tidied'))).toBe(true);
  });

  it('logs also when the retention catch-up marker exists', async () => {
    mkdirSync(join(swarm, 'data'));
    writeFileSync(join(swarm, 'data', 'retention-catch-up'), 'done\n');
    repoWithMain(parent, 'alpha');
    await start('..');
    expect(lines).toContain(`checkouts in ${parent}: alpha`);
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

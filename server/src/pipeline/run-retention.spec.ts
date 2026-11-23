import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { DocumentRepository } from '../history/document.repository';
import { RunEntity } from '../history/entities';
import { MergeRequestLookup } from '../steps/merge-request/merge-request-lookup';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { checkOutputPath } from '../core/check-output';
import { MergeWatch } from './merge-watch';
import { RunRetention } from './run-retention';
import { DAY_MS, ageRun, clean, freshRun, leaveFiles, makeWorld, seedRun, type World } from './workspace.spec-helpers';
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

  it('removes the /tmp folders of an old done run with its worktree, and not the folders of another run', async () => {
    world = await makeWorld('PROJ-1');
    const mine = join(world.swarm, 'worktrees', '.tmp', 'PROJ-1', 'implement');
    const other = join(world.swarm, 'worktrees', '.tmp', 'PROJ-2', 'implement');
    for (const folder of [mine, other]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'scratch'), 'x');
    }
    await seedRun(world.app, 'PROJ-2', 'running', 0);
    await age(world, 10);

    await world.app.get(RunRetention).apply(3);

    expect(existsSync(join(world.swarm, 'worktrees', '.tmp', 'PROJ-1'))).toBe(false);
    expect(existsSync(join(other, 'scratch'))).toBe(true);
  });

  it('frees the workspace of one run now, whatever its age', async () => {
    world = await makeWorld('PROJ-1');
    const tmp = join(world.swarm, 'worktrees', '.tmp', 'PROJ-1', 'implement');
    mkdirSync(tmp, { recursive: true });
    const files = leaveFiles(world.swarm, 'PROJ-1');

    expect(await world.app.get(RunRetention).free(await freshRun(world))).toBe(true);

    expect(existsSync(world.worktree)).toBe(false);
    expect(existsSync(files.state)).toBe(false);
    expect(existsSync(join(world.swarm, 'worktrees', '.tmp', 'PROJ-1'))).toBe(false);
    expect((await freshRun(world)).workspace).toBe('removed');
  });

  it('leaves the workspace of a run that works alone when freeing it', async () => {
    world = await makeWorld('PROJ-1');
    const run = await freshRun(world);
    run.status = 'running';
    run.ownerPid = process.pid;

    expect(await world.app.get(RunRetention).free(run)).toBe(false);

    expect(existsSync(world.worktree)).toBe(true);
    expect((await freshRun(world)).workspace).not.toBe('removed');
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

  it('removes the log folder of a run with it, and not the folder of another run', async () => {
    world = await makeWorld('PROJ-1');
    const mine = join(world.swarm, 'data', 'run-logs', 'PROJ-1');
    const other = join(world.swarm, 'data', 'run-logs', 'PROJ-2');
    mkdirSync(mine, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(mine, 'x-log.txt'), 'out\n');
    writeFileSync(join(other, 'x-log.txt'), 'out\n');
    await age(world, 10);

    expect(await world.app.get(RunRetention).apply(3)).toEqual(['PROJ-1']);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('removes a flat check output file of a run written before the log folder', async () => {
    world = await makeWorld('PROJ-1');
    const flat = join(world.swarm, 'data', 'PROJ-1-checks-attempt1-command-0-log.txt');
    mkdirSync(join(world.swarm, 'data'), { recursive: true });
    writeFileSync(flat, 'out\n');
    await age(world, 10);

    await world.app.get(RunRetention).apply(3);

    expect(existsSync(flat)).toBe(false);
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
    await table.update({ key: 'PROJ-10' }, { state: 'merged' });

    expect(await world.app.get(RunRetention).apply(0)).toEqual(['PROJ-10']);

    expect(existsSync(world.worktree)).toBe(false);
    expect((await freshRun(world)).workspace).toBe('removed');
  });

  it.each(['merged', 'closed'] as const)(
    'a run that turns %s has no worktree and no agent-state folder, and its history stays',
    async (state) => {
      world = await makeWorld('PROJ-12');
      const files = leaveFiles(world.swarm, 'PROJ-12');
      const check = checkOutputPath(world.swarm, 'PROJ-12', 'checks', 'attempt1', 0);
      writeFileSync(check, 'out\n');
      await age(world, 0);
      const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
      await table.update({ key: 'PROJ-12' }, { state });

      expect(await world.app.get(RunRetention).apply(3)).toEqual(['PROJ-12']);

      expect(existsSync(world.worktree)).toBe(false);
      expect(existsSync(join(world.swarm, 'worktrees', 'PROJ-12'))).toBe(false);
      expect(existsSync(files.state)).toBe(false);
      expect(git(world.clone, ['worktree', 'list', '--porcelain'])).not.toContain(world.worktree);
      expect(existsSync(files.output)).toBe(true);
      expect(existsSync(check)).toBe(true);
      expect(existsSync(files.session)).toBe(true);
      expect((await freshRun(world)).workspace).toBe('removed');
    },
  );

  it('frees the worktree of a stopped run whose merge request was merged, after the merge watch made it done', async () => {
    world = await makeWorld('PROJ-15');
    await age(world, 0, 'failed');
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-15' }, { codeHost: 'github' });
    const record = {
      project: 'acme/demo',
      iid: 1,
      url: 'https://github.com/acme/demo/pull/1',
      draft: false,
      summary: '',
    };
    await world.app
      .get(DocumentRepository)
      .putDocument(await freshRun(world), 'merge_request', renderMergeRequest([record]));
    jest
      .spyOn(world.app.get(MergeRequestLookup), 'state')
      .mockResolvedValue({ state: 'merged', sha: 'abc', by: 'queue', at: '2026-05-01T10:00:00Z', httpCalls: [] });

    await world.app.get(MergeWatch).run();

    expect(await world.app.get(RunRetention).apply(3)).toEqual(['PROJ-15']);
    expect(existsSync(world.worktree)).toBe(false);
    const run = await freshRun(world);
    expect([run.status, run.state, run.workspace]).toEqual(['done', 'merged', 'removed']);
  });

  it('keeps everything of a done run that is not merged and younger than the threshold', async () => {
    world = await makeWorld('PROJ-13');
    const files = leaveFiles(world.swarm, 'PROJ-13');
    await age(world, 1);

    expect(await world.app.get(RunRetention).apply(3)).toEqual([]);

    expect(existsSync(world.worktree)).toBe(true);
    expect(existsSync(files.state)).toBe(true);
    expect(existsSync(files.output)).toBe(true);
  });

  it('removes the output files of a freed merged run only after the threshold, and never when it is 0', async () => {
    world = await makeWorld('PROJ-14');
    const files = leaveFiles(world.swarm, 'PROJ-14');
    await age(world, 10);
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-14' }, { state: 'merged' });
    const retention = world.app.get(RunRetention);

    expect(await retention.apply(0)).toEqual(['PROJ-14']);
    expect(existsSync(files.output)).toBe(true);
    expect(await retention.apply(0)).toEqual([]);
    expect(existsSync(files.output)).toBe(true);
    expect(await retention.apply(3)).toEqual(['PROJ-14']);
    expect(existsSync(files.output)).toBe(false);
    expect(await retention.apply(3)).toEqual([]);
  });

  it('cleanOldest skips a freed merged run that has only files left', async () => {
    world = await makeWorld('PROJ-15');
    await age(world, 10);
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    await table.update({ key: 'PROJ-15' }, { state: 'merged' });
    await clean(world);

    expect(await world.app.get(RunRetention).cleanOldest('other')).toBeNull();
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

  /** What a run leaves: a worktree folder, agent state, a /tmp folder, an output, a setup output, a log folder and a session. */
  function leave(key: string): Record<'worktree' | 'state' | 'tmp' | 'output' | 'setup' | 'logs' | 'session', string> {
    const data = join(world.swarm, 'data');
    const files = leaveFiles(world.swarm, key);
    const paths = {
      worktree: join(world.swarm, 'worktrees', key, 'demo'),
      state: files.state,
      tmp: join(world.swarm, 'worktrees', '.tmp', key, 'implement'),
      output: files.output,
      setup: join(data, `${key}-setup-output.txt`),
      logs: join(data, 'run-logs', key),
      session: files.session,
    };
    for (const folder of [paths.worktree, paths.tmp, paths.logs]) {
      mkdirSync(folder, { recursive: true });
    }
    writeFileSync(paths.setup, 'setup\n');
    writeFileSync(join(paths.logs, 'checks-a-command-0-log.txt'), 'log\n');
    return paths;
  }

  const left = (paths: ReturnType<typeof leave>) =>
    Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, existsSync(path)]));

  it('frees and cleans each kind of finished run by the one rule, and keeps a run that is not finished', async () => {
    world = await makeWorld('PROJ-1');
    const table = world.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    const rows: [string, string, Partial<RunEntity>][] = [
      ['PROJ-1', 'done', { state: 'merged' }],
      ['PROJ-2', 'done', { state: 'closed' }],
      ['PROJ-3', 'done', { state: 'done' }],
      ['PROJ-4', 'done', { state: 'merged' }],
      ['PROJ-4-a', 'failed', { state: 'failed' }],
      ['PROJ-4-b', 'blocked', { state: 'skipped', workspace: 'removed' }],
      ['PROJ-5', 'blocked', { state: 'blocked' }],
    ];
    const ageAll = async (days: number) => {
      const updatedAt = new Date(Date.now() - days * DAY_MS).toISOString();
      for (const [key] of rows) {
        await table.update({ key }, { updatedAt });
      }
    };
    for (const [key, status, fields] of rows) {
      if (key !== 'PROJ-1') {
        await seedRun(world.app, key, status, 1);
      }
      await table.update({ key }, fields);
    }
    const epic = (await table.findOneBy({ key: 'PROJ-4' }))!;
    await table.update({ key: 'PROJ-4-a' }, { parentRunId: epic.id });
    await table.update({ key: 'PROJ-4-b' }, { parentRunId: epic.id });
    const paths = Object.fromEntries(rows.map(([key]) => [key, leave(key)]));
    // The workspace of the skipped subtask was freed by its epic's close: no folders are left, only files.
    for (const folder of ['worktree', 'state', 'tmp'] as const) {
      rmSync(paths['PROJ-4-b'][folder], { recursive: true, force: true });
    }
    const everything = { worktree: true, state: true, tmp: true, output: true, setup: true, logs: true, session: true };
    const freed = { ...everything, worktree: false, state: false, tmp: false };
    const cleaned = { ...freed, output: false, setup: false, logs: false };
    await ageAll(1);

    await world.app.get(RunRetention).apply(3);

    expect(left(paths['PROJ-1'])).toEqual(freed);
    expect(left(paths['PROJ-2'])).toEqual(freed);
    expect(left(paths['PROJ-3'])).toEqual(everything);
    expect(left(paths['PROJ-4'])).toEqual(freed);
    expect(left(paths['PROJ-4-a'])).toEqual(everything);
    expect(left(paths['PROJ-4-b'])).toEqual({ ...everything, worktree: false, state: false, tmp: false });
    expect(left(paths['PROJ-5'])).toEqual(everything);

    await ageAll(10);
    await world.app.get(RunRetention).apply(3);

    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-4-a']) {
      expect([key, left(paths[key])]).toEqual([key, cleaned]);
    }
    expect(left(paths['PROJ-4-b'])).toEqual(cleaned);
    expect(left(paths['PROJ-5'])).toEqual(everything);
    for (const [key] of rows) {
      expect(existsSync(paths[key].session)).toBe(true);
    }
  });

  it('removes a setup output, also an older one named by repository, with an old done run', async () => {
    world = await makeWorld('PROJ-1');
    await seedRun(world.app, 'PROJ-1-sub', 'running', 10);
    await age(world, 10);
    const data = join(world.swarm, 'data');
    for (const name of ['PROJ-1-setup-output.txt', 'PROJ-1-demo-setup-output.txt', 'PROJ-1-sub-setup-output.txt']) {
      writeFileSync(join(data, name), 'setup\n');
    }

    await world.app.get(RunRetention).apply(3);

    expect(existsSync(join(data, 'PROJ-1-setup-output.txt'))).toBe(false);
    expect(existsSync(join(data, 'PROJ-1-demo-setup-output.txt'))).toBe(false);
    expect(existsSync(join(data, 'PROJ-1-sub-setup-output.txt'))).toBe(true);
  });

  it('removes a /tmp folder whose run no longer exists and keeps one whose run does', async () => {
    world = await makeWorld('PROJ-1');
    const gone = join(world.swarm, 'worktrees', '.tmp', 'GONE-1', 'implement');
    const live = join(world.swarm, 'worktrees', '.tmp', 'PROJ-1', 'implement');
    for (const days of [3, 0]) {
      mkdirSync(gone, { recursive: true });
      mkdirSync(live, { recursive: true });

      await world.app.get(RunRetention).apply(days);

      expect(existsSync(gone)).toBe(false);
      expect(existsSync(live)).toBe(true);
    }
  });
});

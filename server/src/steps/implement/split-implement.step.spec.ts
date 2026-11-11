import 'reflect-metadata';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RunCommandsService } from '../../api/run-commands.service';
import { ERROR_CODES } from '../../contract/error-codes';
import { parseSubtasks, type Subtask } from '../../contract/subtask';
import { DocumentEntity } from '../../history/entities';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { Reconciler } from '../../pipeline/reconciler';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { save } from '../../testing/runs.spec-helpers';
import { NO_CI_NOTE } from './split-implement.step';

const KEY = 'PROJ-300';

const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

/** An app with the real implement step. Starting a subtask run is recorded, not run. */
async function world(env: Record<string, string> = {}) {
  const app = await createTestApp({
    realImplement: true,
    env,
    sandbox: { stopRun: () => Promise.resolve('gone') },
  });
  return { app, ...instrument(app) };
}

function instrument(app: TestApp) {
  const launched: string[] = [];
  const original = app.pipeline.startDetached.bind(app.pipeline);
  jest.spyOn(app.pipeline, 'startDetached').mockImplementation((key, ...rest) => {
    if (key === KEY) return original(key, ...rest);
    launched.push(key);
    return Promise.resolve({ exitCode: 0, message: `${key} started` });
  });
  return { launched };
}

async function seedParent(app: TestApp, tasks: Subtask[]) {
  const runs = app.app.get(RunRepository);
  const parent = await save(runs, KEY, 'implement', 'waiting');
  parent.split = true;
  parent.projects = 'demo\n';
  await runs.saveRun(parent);
  const documents = app.app.get(DocumentRepository);
  await documents.putDocument(parent, 'requirements', requirements);
  await documents.putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  return parent;
}

async function pass(app: TestApp) {
  return app.pipeline.step('implement', KEY);
}

/** Waits for the commands accepted so far and for the pass they started. */
async function settle(app: TestApp): Promise<void> {
  await app.app.get(CommandService).idle();
  await app.pipeline.whenIdle(KEY);
}

async function tasksOf(app: TestApp): Promise<Subtask[]> {
  return parseSubtasks(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks'));
}

const statuses = async (app: TestApp) => Object.fromEntries((await tasksOf(app)).map((item) => [item.id, item.status]));

async function setStatus(app: TestApp, id: string, status: Subtask['status']): Promise<void> {
  const parent = (await app.app.get(RunRepository).findRun(KEY))!;
  const tasks = (await tasksOf(app)).map((item) => (item.id === id ? { ...item, status } : item));
  await app.app.get(DocumentRepository).putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
}

async function child(app: TestApp, id: string) {
  return (await app.app.get(RunRepository).findRun(`${KEY}-${id}`))!;
}

/** The subtask run works: its owner is alive. */
async function work(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'running', currentStep: 'research', ownerPid: process.pid });
  await app.app.get(RunRepository).saveRun(run);
}

async function finish(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'done', currentStep: 'done' });
  await app.app.get(RunRepository).saveRun(run);
}

async function parentState(app: TestApp) {
  return deriveState((await app.app.get(RunRepository).findRun(KEY))!);
}

describe('split implement', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('makes a run for every task at once, starts those with no dependency, and holds no claim between passes', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a']), task('c')]);

    await pass(app);

    const runs = app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    expect((await runs.children(parent)).map((run) => run.key)).toEqual([`${KEY}-a`, `${KEY}-b`, `${KEY}-c`]);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-c`]);
    expect(existsSync(join(app.root, 'worktrees', `${KEY}-b`))).toBe(false);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'waiting', c: 'running' });
    expect((await tasksOf(app))[1]?.note).toBe('waiting for a');
    expect(deriveState(await child(app, 'b')).reason).toMatchObject({
      code: ERROR_CODES.SUBTASK_WAITING,
      message: 'waiting for a',
    });
    expect(parent).toMatchObject({ status: 'waiting', ownerPid: null, activeAttempt: null });
    expect(runs.held(parent)).toBe(false);
    expect((await parentState(app)).reason).toMatchObject({ code: ERROR_CODES.SUBTASKS_RUNNING });
  });

  it('runs at most SUBTASKS_PARALLEL tasks at once', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b'), task('c'), task('d')]);

    await pass(app);
    expect(built.launched).toHaveLength(3);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'running', c: 'running', d: 'waiting' });

    await setStatus(app, 'a', 'merged');
    await pass(app);
    expect(built.launched).toHaveLength(4);
    expect(await statuses(app)).toMatchObject({ a: 'merged', d: 'running' });
  });

  it('starts a task only when its dependencies are merged or skipped', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a']), task('c', ['b'])]);

    await pass(app);
    expect(built.launched).toEqual([`${KEY}-a`]);

    await finish(app, 'a');
    await pass(app);
    expect(await statuses(app)).toEqual({ a: 'green', b: 'waiting', c: 'waiting' });
    expect(built.launched).toEqual([`${KEY}-a`]);

    await setStatus(app, 'a', 'merged');
    await pass(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`]);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'running', c: 'waiting' });
  });

  it('changes nothing when a pass runs twice in a row', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    const documents = app.app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const stored = () => documents.count({ where: { kind: 'subtasks' } });

    await pass(app);
    const body = await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks');
    const count = await stored();
    const children = (await app.app.get(RunRepository).listRuns()).length;

    await pass(app);

    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks')).toBe(body);
    expect(await stored()).toBe(count);
    expect((await app.app.get(RunRepository).listRuns()).length).toBe(children);
    expect(built.launched).toEqual([`${KEY}-a`]);
  });

  it('starts a pass through the command door when a subtask run ends', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);

    // The subtask run goes through its steps and ends done; the parent hears of it and runs a pass.
    await app.pipeline.runThrough(`${KEY}-a`);
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'green', b: 'waiting' });
    expect((await parentState(app)).state).toBe('waiting');
  });

  it('records no CI on the feature branch for a green subtask whose merge request had no pipeline', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    await finish(app, 'a');
    await app.app
      .get(DocumentRepository)
      .putDocument(await child(app, 'a'), 'pipeline_log', 'result: none\nnothing started\nproject: demo\n');

    await pass(app);

    expect((await tasksOf(app))[0]).toMatchObject({ status: 'green', note: NO_CI_NOTE });
  });

  it('blocks the parent naming the failed subtask, and Skip task goes on', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    const failed = await child(app, 'a');
    writeRunState(failed, { status: 'blocked', reason: { code: 'BLOCKED', message: 'review kept returning' } });
    await app.app.get(RunRepository).saveRun(failed);

    await pass(app);

    const blocked = await parentState(app);
    expect(blocked.state).toBe('blocked');
    expect(blocked.reason).toMatchObject({ code: ERROR_CODES.SUBTASK_BLOCKED });
    expect(blocked.reason?.message).toContain('subtask a');

    await app.app.get(CommandService).submit('skip', KEY, { taskId: 'a' });
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'skipped', b: 'running' });
    expect(built.launched).toContain(`${KEY}-b`);
    expect((await parentState(app)).state).toBe('waiting');
  });

  it('stops every subtask and starts none when the parent is stopped, and Resume goes on', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b'), task('c', ['a'])]);
    await pass(app);
    await work(app, 'a');
    await work(app, 'b');

    await app.app.get(CommandService).submit('stop', KEY, {});

    expect((await parentState(app)).state).toBe('stopped');
    expect(deriveState(await child(app, 'a')).state).toBe('stopped');
    expect(deriveState(await child(app, 'b')).state).toBe('stopped');
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`]);
    expect((await parentState(app)).state).toBe('stopped');

    await app.app.get(CommandService).submit('resume', KEY, {});
    await settle(app);

    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`, `${KEY}-a`, `${KEY}-b`]);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'running', c: 'waiting' });
    expect((await parentState(app)).state).toBe('waiting');
  });

  it('goes on after a restart', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await finish(app, 'a');

    app = await app.restart();
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'green', b: 'waiting' });
  });

  it('is started by the reconciler timer for a parent that waits', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    await finish(app, 'a');

    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'green' });
  });

  it('removes the subtasks of a Replay at plan, and keeps them for a Replay at a later step', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    jest.spyOn(app.pipeline, 'replay').mockResolvedValue({ exitCode: 0, message: 'started' });
    const runs = app.app.get(RunRepository);
    const commands = app.app.get(CommandService);

    await commands.submit('replay', KEY, { step: 'checks', prompt: 'again' });
    expect(await runs.children((await runs.findRun(KEY))!)).toHaveLength(2);

    await commands.submit('replay', KEY, { step: 'plan', prompt: 'again' });
    expect(await runs.children((await runs.findRun(KEY))!)).toEqual([]);
    expect((await runs.listRuns()).map((run) => run.key)).toEqual([KEY]);
  });

  it('leaves no subtask, row or worktree, behind when the parent is removed', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    mkdirSync(join(app.root, 'worktrees', `${KEY}-a`, 'demo'), { recursive: true });

    await app.app.get(RunCommandsService).remove(KEY);

    expect(await app.app.get(RunRepository).listRuns()).toEqual([]);
    expect(existsSync(join(app.root, 'worktrees', `${KEY}-a`))).toBe(false);
  });

  it('moves the parent to checks, skipping implement-improve, when every task is merged or skipped', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await setStatus(app, 'a', 'merged');
    await setStatus(app, 'b', 'skipped');

    await pass(app);

    const parent = (await app.app.get(RunRepository).findRun(KEY))!;
    expect(parent).toMatchObject({ currentStep: 'checks', status: 'waiting' });
    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'implementation')).toContain('Task a (merged)');
  });

  it('leaves a settled parent with a rebase conflict to the agent path, not the passes', async () => {
    const built = await world();
    app = built.app;
    const parent = await seedParent(app, [task('a')]);
    await setStatus(app, 'a', 'merged');
    await app.app.get(DocumentRepository).putDocument(parent, 'rebase_conflict', 'pending\n');

    await pass(app);

    expect((await app.app.get(RunRepository).findRun(KEY))?.currentStep).not.toBe('checks');
  });

  it('keeps a parent stopped that a blocked subtask held', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    await work(app, 'b');
    const failed = await child(app, 'a');
    writeRunState(failed, { status: 'blocked', reason: { code: 'BLOCKED', message: 'x' } });
    await app.app.get(RunRepository).saveRun(failed);
    await pass(app);
    expect((await parentState(app)).reason?.code).toBe(ERROR_CODES.SUBTASK_BLOCKED);

    await app.app.get(CommandService).submit('stop', KEY, {});
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);

    expect((await parentState(app)).state).toBe('stopped');
  });
});

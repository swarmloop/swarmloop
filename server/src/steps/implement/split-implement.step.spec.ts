import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RunCommandsService } from '../../api/run-commands.service';
import { ERROR_CODES } from '../../contract/error-codes';
import { DocumentEntity } from '../../history/entities';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { PERSON_RESUME } from '../../pipeline/resume-sender';
import { Reconciler } from '../../pipeline/reconciler';
import { FAKE_MODEL_KEY } from '../../testing/env.spec-helpers';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { NO_CI_NOTE } from './split-pass';
import { git } from '../../testing/runs.spec-helpers';

import {
  FEATURE,
  KEY,
  child,
  mergeWorld,
  opened,
  finish,
  parentState,
  pass,
  seedMergeParent,
  seedParent,
  setStatus,
  settle,
  statuses,
  task,
  tasksOf,
  work,
  world,
} from './split-implement.spec-helpers';

/** The run of a task is done and its merge is recorded, as a pass that merged it leaves it. */
async function recordMerge(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, {
    status: 'done',
    currentStep: 'done',
    merge: { merged: { demo: { sha: 'abc', by: null, at: '2026-11-19T00:07:10.000Z', url: null } } },
  });
  await storeRun(app.app.get(RunRepository), run);
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
    expect(storedState(await child(app, 'b')).reason).toMatchObject({
      code: ERROR_CODES.SUBTASK_WAITING,
      message: 'waiting for a',
    });
    expect(parent).toMatchObject({ status: 'waiting', ownerPid: null, activeAttempt: null });
    expect(runs.held(parent)).toBe(false);
    expect((await parentState(app)).reason).toMatchObject({ code: ERROR_CODES.SUBTASKS_RUNNING });
  });

  it('names each waiting subtask and what it waits on in the reason of the parent and in its note', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    const waiting = await child(app, 'a');
    writeRunState(waiting, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'waiting for b: withHostRetries' },
    });
    await storeRun(app.app.get(RunRepository), waiting);

    await pass(app);

    expect((await tasksOf(app))[0]?.note).toBe('a waits for b: withHostRetries');
    expect((await parentState(app)).reason?.message).toContain('a waits for b: withHostRetries');
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

  it('marks a task skipped with the note when its run ended with the behavior already delivered, and its dependent starts', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await finish(app, 'a');
    await app.app.get(DocumentRepository).putDocument(await child(app, 'a'), 'commit', 'already delivered: src/a.ts\n');

    await pass(app);

    expect(await tasksOf(app)).toMatchObject([
      { id: 'a', status: 'skipped', note: 'already delivered: src/a.ts' },
      { id: 'b', status: 'running' },
    ]);
  });

  it('blocks the parent naming the failed subtask, and Skip task goes on', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    const failed = await child(app, 'a');
    writeRunState(failed, { status: 'blocked', reason: { code: 'BLOCKED', message: 'review kept returning' } });
    await storeRun(app.app.get(RunRepository), failed);

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
    expect(storedState(await child(app, 'a')).state).toBe('stopped');
    expect(storedState(await child(app, 'b')).state).toBe('stopped');
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`]);
    expect((await parentState(app)).state).toBe('stopped');

    await app.app.get(CommandService).submit('resume', KEY, { ...PERSON_RESUME });
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
    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'implementation_result')).toContain('Task a (merged)');
  });

  it('takes a task merged by an earlier pass as merged and moves the parent on', async () => {
    const built = await world();
    app = built.app;
    const parent = await seedParent(app, [task('a'), task('b', ['a'])]);
    await app.app.get(DocumentRepository).putDocument(parent, 'repos', 'demo\n');
    await pass(app);
    await setStatus(app, 'a', 'merged');
    await setStatus(app, 'b', 'green');
    await recordMerge(app, 'b');

    await pass(app);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged' });
    expect((await tasksOf(app))[1]?.merged).toEqual({ demo: 'abc' });
    expect(await app.app.get(RunRepository).findRun(KEY)).toMatchObject({ currentStep: 'checks', status: 'waiting' });
  });

  it('is not quiet and is started by the timer when its subtasks say green for a child whose merge is recorded', async () => {
    const built = await world();
    app = built.app;
    const seeded = await seedParent(app, [task('a'), task('b')]);
    await app.app.get(DocumentRepository).putDocument(seeded, 'repos', 'demo\n');
    await pass(app);
    await setStatus(app, 'a', 'merged');
    await setStatus(app, 'b', 'green');
    await recordMerge(app, 'b');
    const runs = app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    writeRunState(parent, {
      status: 'waiting',
      reason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'running' },
    });
    await storeRun(runs, parent);
    await runs.recordSubtaskFingerprint(parent, await runs.subtaskFingerprint(parent));

    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged' });
    expect((await app.app.get(RunRepository).findRun(KEY))?.currentStep).not.toBe('implement');
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
    await seedParent(app, [task('a')]);
    await pass(app);
    const failed = await child(app, 'a');
    writeRunState(failed, { status: 'blocked', reason: { code: 'BLOCKED', message: 'x' } });
    await storeRun(app.app.get(RunRepository), failed);
    await pass(app);
    expect((await parentState(app)).reason?.code).toBe(ERROR_CODES.SUBTASK_BLOCKED);

    await app.app.get(CommandService).submit('stop', KEY, {});
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);

    expect((await parentState(app)).state).toBe('stopped');
  });
});

describe('a new run', () => {
  it('splits through the command door when SPLIT is left at its default', async () => {
    const app = await createTestApp({ env: FAKE_MODEL_KEY });
    try {
      const response = await fetch(`${app.url}/runs`, {
        method: 'POST',
        headers: { ...app.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'PROJ-301', prompt: 'Ship it', projects: ['demo'] }),
      });
      expect(response.status).toBe(202);
      expect((await app.app.get(RunRepository).findRun('PROJ-301'))?.split).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('split merge', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('merges the green tasks one at a time in task order, into the feature branch only, and moves the parent worktree', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b'), task('c', ['a'])]);
    await opened(app, built.host, 'b', { demo: 2 });
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    await finish(app, 'b');

    await pass(app);

    expect(built.host.merges).toEqual([1, 2]);
    expect(built.host.merges.map((iid) => built.host.targets.get(iid))).toEqual([FEATURE, FEATURE]);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'running' });
    expect(built.launched).toContain(`${KEY}-c`);
    const tasks = await tasksOf(app);
    expect(tasks[0]?.merged).toEqual({ demo: built.host.merged.get(1) });
    expect(git(built.tree, ['rev-parse', 'HEAD'])).toBe(built.host.merged.get(2));
  });

  it('records the merge and names both heads when the parent worktree has commits the feature branch lacks', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    writeFileSync(join(built.tree, 'local.txt'), 'local\n');
    git(built.tree, ['add', '.']);
    git(built.tree, ['commit', '-m', 'local']);
    const local = git(built.tree, ['rev-parse', 'HEAD']);

    const result = await pass(app);

    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect(built.host.merges).toEqual([1]);
    expect(result.message).toContain(local);
    expect(result.message).toContain(`${FEATURE} at ${built.host.merged.get(1)}`);
    expect(git(built.tree, ['rev-parse', 'HEAD'])).toBe(local);

    await pass(app);
    expect(built.host.merges).toEqual([1]);
  });

  it('deletes the branch of a merged subtask', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');

    await pass(app);

    expect(built.host.deleted).toEqual(['feature/PROJ-300-a-ship-the-field']);
  });

  it('sends a Rebase to a subtask whose merge conflicts, and merges it when it comes back green', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    built.host.conflicts.add(1);

    await pass(app);

    expect(built.rebased).toEqual([`${KEY}-a`]);
    expect(built.host.merges).toEqual([]);
    expect(await statuses(app)).toEqual({ a: 'running' });

    built.host.conflicts.delete(1);
    await pass(app);

    expect(built.host.merges).toEqual([1]);
    expect(await statuses(app)).toEqual({ a: 'merged' });
  });

  it('sends a Rebase to an open subtask whose merge request conflicts after a merge', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await opened(app, built.host, 'b', { demo: 2 });
    await finish(app, 'a');
    const second = await child(app, 'b');
    writeRunState(second, { status: 'waiting', currentStep: 'code-review' });
    await storeRun(app.app.get(RunRepository), second);
    built.host.conflicts.add(2);

    await pass(app);

    expect(built.host.merges).toEqual([1]);
    expect(built.rebased).toEqual([`${KEY}-b`]);
  });

  it('merges a task over two repositories one after the other, and only the one left after a crash between them', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1, lib: 2 });
    await finish(app, 'a');
    built.host.crashOn = 2;

    await pass(app);

    expect(built.host.merges).toEqual([1]);

    built.host.crashOn = null;
    await pass(app);

    expect(built.host.merges).toEqual([1, 2]);
    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect((await tasksOf(app))[0]?.merged).toEqual({
      demo: built.host.merged.get(1),
      lib: built.host.merged.get(2),
    });
  });

  it('does not merge twice when the host reports the request merged before it was recorded', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    built.host.merged.set(1, 'abc123');

    await pass(app);

    expect(built.host.merges).toEqual([]);
    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect((await tasksOf(app))[0]?.merged).toEqual({ demo: 'abc123' });
  });

  it('blocks the parent with the message of a host that refuses a merge for another reason than a conflict', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    built.host.refusal = 'At least 1 approving review is required';

    await pass(app);

    const state = await parentState(app);
    expect(state.state).toBe('blocked');
    expect(state.reason).toMatchObject({ code: ERROR_CODES.SUBTASK_BLOCKED });
    expect(state.reason?.message).toContain('At least 1 approving review is required');
    expect(built.rebased).toEqual([]);
    expect(await statuses(app)).toEqual({ a: 'green' });
  });

  it('closes the merge requests of the subtasks on a Replay at plan', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await opened(app, built.host, 'b', { demo: 2 });
    jest.spyOn(app.pipeline, 'replay').mockResolvedValue({ exitCode: 0, message: 'started' });

    await app.app.get(CommandService).submit('replay', KEY, { step: 'plan', prompt: 'again' });

    expect(built.host.closed).toEqual([1, 2]);
  });
});

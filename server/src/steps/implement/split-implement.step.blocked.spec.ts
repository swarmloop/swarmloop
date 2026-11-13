import 'reflect-metadata';
import { DocumentRepository } from '../../history/document.repository';
import { FetchFailed } from '../../core/swarmloop-error';
import { SubtaskOps } from '../shared/subtask-ops';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import { ERROR_CODES } from '../../contract/error-codes';
import type { TestApp } from '../../testing/test-app';
import { child, parentState, pass, seedParent, task, tasksOf, work, world } from './split-implement.spec-helpers';

async function block(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'blocked', reason: { code: 'BLOCKED', message: 'x' } });
  await app.app.get(RunRepository).saveRun(run);
}

describe('split implement, a blocked task', () => {
  let app: TestApp;

  afterEach(async () => {
    await app.close();
  });

  it('holds back only its dependents: an independent task starts and the parent waits', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a']), task('c', ['b']), task('d')]);
    await pass(app);
    await block(app, 'a');
    await pass(app);

    const tasks = await tasksOf(app);
    expect(tasks.map((item) => item.status)).toEqual(['blocked', 'waiting', 'waiting', 'running']);
    expect(tasks[1].note).toBe('waiting for a, which is blocked');
    expect(tasks[2].note).toBe('waiting for a, which is blocked');
    const state = await parentState(app);
    expect(state.state).toBe('waiting');
    expect(state.reason?.code).toBe(ERROR_CODES.SUBTASKS_RUNNING);
    expect(state.reason?.message).toContain('subtask a is blocked; Resume, Replay or Skip task clears it');
  });

  it('is SUBTASK_BLOCKED when nothing else can move', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await block(app, 'a');
    await pass(app);

    const state = await parentState(app);
    expect(state.state).toBe('blocked');
    expect(state.reason?.code).toBe(ERROR_CODES.SUBTASK_BLOCKED);
    expect(state.reason?.message).toContain('subtask a is blocked');
  });

  it('names the blocked task and its action in the wait when the branch of a green task cannot be fetched', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    await block(app, 'a');
    const green = await child(app, 'b');
    const record = { project: 'demo', iid: 2, url: 'https://code.example/demo/2', draft: false, summary: '' };
    await app.app.get(DocumentRepository).putDocument(green, 'repos', 'demo\n');
    await app.app.get(DocumentRepository).putDocument(green, 'merge_request', renderMergeRequest([record]));
    writeRunState(green, { status: 'done', currentStep: 'done' });
    await app.app.get(RunRepository).saveRun(green);
    jest
      .spyOn(app.app.get(SubtaskOps), 'behindTip')
      .mockRejectedValue(new FetchFailed('main of demo could not be fetched'));

    await pass(app);

    const state = await parentState(app);
    expect(state.state).toBe('waiting');
    expect(state.reason?.code).toBe(ERROR_CODES.HOST_UNAVAILABLE);
    expect(state.reason?.retryAt).toBeDefined();
    expect(state.reason?.message).toContain('subtask a is blocked; Resume, Replay or Skip task clears it');
    expect(state.reason?.message).toContain('could not be fetched');
  });

  it('says a task that waits only for a slot is waiting for a free slot', async () => {
    const built = await world({ SUBTASKS_PARALLEL: '1' });
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);

    const tasks = await tasksOf(app);
    expect(tasks[1].note).toBe('waiting for a free slot: 1 of SUBTASKS_PARALLEL running');
  });

  it('skips a pass while the blocked task is as it was, and runs one after a Resume of it', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    await block(app, 'a');
    await pass(app);
    expect((await parentState(app)).state).toBe('waiting');

    expect((await pass(app)).message).toContain('has nothing new');

    await work(app, 'a');
    const resumed = await pass(app);

    expect(resumed.message).not.toContain('has nothing new');
    expect((await tasksOf(app)).map((item) => item.status)).toEqual(['running', 'running']);
    expect((await parentState(app)).reason?.message).not.toContain('is blocked');
  });
});

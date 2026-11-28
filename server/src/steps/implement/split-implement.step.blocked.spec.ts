import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { FetchFailed } from '../../core/swarmloop-error';
import { RunHosts } from '../../integrations/code-host/run-hosts';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { SubtaskOps } from '../shared/subtask-ops';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import { ERROR_CODES } from '../../contract/error-codes';
import { COMMAND_TYPES } from '../../contract/command';
import { actionsFor } from '../../contract/run-state';
import type { TestApp } from '../../testing/test-app';
import {
  child,
  finish,
  KEY,
  mergeWorld,
  opened,
  parentState,
  pass,
  requirements,
  seedMergeParent,
  seedParent,
  statuses,
  task,
  tasksOf,
  work,
  world,
} from './split-implement.spec-helpers';

async function block(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'blocked', reason: { code: 'BLOCKED', message: 'x' } });
  await storeRun(app.app.get(RunRepository), run);
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
    expect(actionsFor(state.state, state.reason?.code ?? null)).toEqual(expect.arrayContaining(['resume', 'replay']));
    expect(COMMAND_TYPES).toContain('skip');
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
    await app.app.get(DocumentRepository).putDocument(green, 'requirements', requirements);
    await app.app.get(DocumentRepository).putDocument(green, 'repos', 'demo\n');
    await app.app.get(DocumentRepository).putDocument(green, 'merge_request', renderMergeRequest([record]));
    writeRunState(green, { status: 'done', currentStep: 'done' });
    await storeRun(app.app.get(RunRepository), green);
    const open = { state: 'open', sha: null, draft: false, head: 'head', mergeability: 'clean', blockedBy: null };
    const host = {
      readMergeGate: () => Promise.resolve({ ...open, httpCalls: [] }),
      readBranchPipeline: () => Promise.resolve({ snapshot: null, httpCalls: [] }),
    };
    jest.spyOn(RunHosts.prototype, 'byName').mockReturnValue(host as unknown as CodeHost);
    jest.spyOn(RunHosts.prototype, 'requiredCredentials').mockReturnValue({} as never);
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

  const OWN_CONFLICT = "the parent's own uncommitted edits in demo conflict with origin/feature in src/shared.ts";

  it('goes on with its tasks and waits naming the conflict of its own edits', async () => {
    const built = await mergeWorld();
    app = built.app;
    jest
      .spyOn(app.app.get(SubtaskOps), 'commitOwnEdits')
      .mockResolvedValue({ committed: null, conflict: OWN_CONFLICT });
    await seedMergeParent(app, [task('a'), task('b'), task('c', ['a'])]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');

    const result = await pass(app);

    expect(built.host.merges).toEqual([1]);
    expect(built.launched).toContain(`${KEY}-c`);
    const state = await parentState(app);
    expect(state.state).toBe('waiting');
    expect(state.reason?.code).not.toBe(ERROR_CODES.PARENT_TREE_CONFLICT);
    expect(state.reason?.message).toContain(OWN_CONFLICT);
    expect(state.reason?.message).toContain('the implement agent resolves it once every task is settled');
    expect(result.message).toContain(OWN_CONFLICT);
    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'rebase_conflict')).toBeNull();
  });

  it('parks the conflict of its own edits and goes to implement when the last task merges in the pass', async () => {
    const built = await mergeWorld();
    app = built.app;
    const commit = jest
      .spyOn(app.app.get(SubtaskOps), 'commitOwnEdits')
      .mockResolvedValue({ committed: null, conflict: OWN_CONFLICT });
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');

    await pass(app);

    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect(commit.mock.calls.at(-1)?.[1]).toBe(true);
    expect((await app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('implement');
    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'rebase_conflict')).toContain('parent-own-edits');
  });
});

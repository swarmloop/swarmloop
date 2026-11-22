import 'reflect-metadata';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { actionsFor, type MergeOutcome } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { child, KEY, mergeWorld, opened, seedMergeParent, task } from '../steps/implement/split-implement.spec-helpers';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { SubtaskPort } from './subtask-port';
import type { TestApp } from '../testing/test-app';
import { EpicLeftovers } from './epic-leftovers';

const MERGED: MergeOutcome = { merged: { demo: { sha: 'abc', by: 'queue', at: '2026-05-01T10:00:00Z', url: null } } };
const CLOSED: MergeOutcome = { closed: { repo: 'demo', by: 'grace', at: '2026-05-02T08:00:00Z' } };

describe('EpicLeftovers', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const folders = (key: string) => [
    join(app.root, 'worktrees', key),
    join(app.root, 'data', 'agent-state', key),
    join(app.root, 'worktrees', '.tmp', key),
  ];

  /** An epic with a waiting task a, a failed task b and a merged task c, each with an open merge request and folders. */
  async function endedEpic(outcome: MergeOutcome) {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b'), task('c')]);
    const runs = app.app.get(RunRepository);
    const ids = { a: 1, b: 2, c: 3 };
    for (const [id, iid] of Object.entries(ids)) {
      await opened(app, built.host, id, { demo: iid });
      for (const folder of folders(`${KEY}-${id}`)) mkdirSync(folder, { recursive: true });
    }
    const failed = await child(app, 'b');
    writeRunState(failed, { status: 'failed', currentStep: 'commit' });
    await runs.saveRun(failed);
    const merged = await child(app, 'c');
    writeRunState(merged, { status: 'done', currentStep: 'done', merge: MERGED });
    await runs.saveRun(merged);
    const parent = (await runs.findRun(KEY))!;
    const list = [
      { ...task('a'), status: 'skipped', note: 'nothing left to do' },
      { ...task('b'), note: 'b waits for flaky-detect' },
      { ...task('c'), status: 'merged' },
    ];
    await app.app.get(DocumentRepository).putDocument(parent, 'subtasks', `${JSON.stringify(list)}\n`);
    writeRunState(parent, { status: 'done', currentStep: 'done', merge: outcome });
    await runs.saveRun(parent);
    return built.host;
  }

  const pass = () =>
    new EpicLeftovers(app.app.get(RunRepository), app.app.get(DocumentRepository), app.app.get(SubtaskOps)).run();

  it('closes the waiting and the failed task of a merged epic and leaves the merged one alone', async () => {
    const host = await endedEpic(MERGED);

    await pass();

    const a = await child(app, 'a');
    const b = await child(app, 'b');
    expect([storedState(a).state, storedState(a).reason?.message, a.workspace]).toEqual([
      'skipped',
      'skipped by its epic: nothing left to do',
      'removed',
    ]);
    expect([storedState(b).state, storedState(b).reason?.message, b.workspace]).toEqual([
      'skipped',
      'skipped by its epic: nothing left to do',
      'removed',
    ]);
    expect(actionsFor('skipped')).toEqual([]);
    expect(host.closed).toEqual([1, 2]);
    for (const id of ['a', 'b']) {
      expect(folders(`${KEY}-${id}`).map((folder) => existsSync(folder))).toEqual([false, false, false]);
    }
    const c = await child(app, 'c');
    expect([storedState(c).state, c.workspace]).toEqual(['merged', null]);
    expect(folders(`${KEY}-c`).map((folder) => existsSync(folder))).toEqual([true, true, true]);
  });

  it('gives the progress note of a task that was not skipped no place in the reason', async () => {
    await endedEpic(MERGED);

    await pass();

    expect(storedState(await child(app, 'b')).reason?.message).toBe('skipped by its epic: nothing left to do');
  });

  it('leaves a child as it was when its stop fails, and closes it on the next pass', async () => {
    const host = await endedEpic(MERGED);
    const before = storedState(await child(app, 'a')).state;
    jest.spyOn(app.app.get(SubtaskPort), 'stop').mockRejectedValueOnce(new Error('no stop'));

    await pass();

    expect([storedState(await child(app, 'a')).state, host.closed]).toEqual([before, [2]]);
    await pass();
    expect([storedState(await child(app, 'a')).state, host.closed]).toEqual(['skipped', [2, 1]]);
  });

  it('says the epic was closed when it ended without a merge', async () => {
    await endedEpic(CLOSED);

    await pass();

    expect(storedState(await child(app, 'b')).reason?.message).toBe('the epic was closed');
  });

  it('changes nothing on a second pass', async () => {
    const host = await endedEpic(MERGED);
    await pass();
    const before = [await child(app, 'a'), await child(app, 'b')].map((run) => run.revision);

    await pass();

    expect([await child(app, 'a'), await child(app, 'b')].map((run) => run.revision)).toEqual(before);
    expect(host.closed).toEqual([1, 2]);
  });
});

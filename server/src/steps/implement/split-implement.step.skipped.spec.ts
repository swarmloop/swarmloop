import 'reflect-metadata';
import { RunSubtaskCommandsService } from '../../api/run-subtask-commands.service';
import { actionsFor, SKIPPED_NOTE } from '../../contract/run-state';
import { PlanChatStore } from '../../history/plan-chat.store';
import { skippedByEpic } from '../shared/subtask-skip-reason';
import { DocumentRepository } from '../../history/document.repository';
import { storedState } from '../../history/run-state';
import type { TestApp } from '../../testing/test-app';
import {
  child,
  finish,
  KEY,
  mergeWorld,
  opened,
  pass,
  seedMergeParent,
  statuses,
  task,
} from './split-implement.spec-helpers';

describe('split implement: a skipped task and its merge request', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** The run of task a ended with the behavior already delivered, and its merge request is open. */
  async function delivered(built: Awaited<ReturnType<typeof mergeWorld>>) {
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    await app.app.get(DocumentRepository).putDocument(await child(app, 'a'), 'commit', 'already delivered: src/a.ts\n');
  }

  it('closes the open merge request of a task that ended already delivered, once', async () => {
    const built = await mergeWorld();
    app = built.app;
    await delivered(built);

    await pass(app);

    expect(await statuses(app)).toEqual({ a: 'skipped' });
    expect(built.host.closed).toEqual([1]);
  });

  it('leaves the merge request of a merged task alone', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');

    await pass(app);

    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect(built.host.closed).toEqual([]);
  });

  it('closes the open merge request of a task a person skips', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });

    await app.app.get(RunSubtaskCommandsService).skipTask(KEY, 'a');

    expect(await statuses(app)).toEqual({ a: 'skipped' });
    expect(built.host.closed).toEqual([1]);
  });

  /** The part's planner escalated a question that waits for an answer. */
  async function escalated(id: string) {
    const chat = app.app.get(PlanChatStore);
    const { key } = await child(app, id);
    await chat.appendEntry(key, {
      key: 'escalate-1',
      role: 'planner',
      kind: 'escalation',
      text: 'Which one?',
      at: '2026-01-01T00:00:00.000Z',
      state: 'pending',
    });
    return async () => (await chat.read(key)).entries.map((entry) => [entry.state, entry.closed]);
  }

  it('closes the open question of a part a person skips with the skip as the reason', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    const entries = await escalated('a');

    await app.app.get(RunSubtaskCommandsService).skipTask(KEY, 'a');

    expect(await entries()).toEqual([['taken', SKIPPED_NOTE]]);
    expect(storedState(await child(app, 'a')).state).toBe('skipped');
  });

  it("closes the open question of a part the epic's own pass skips with the epic's reason", async () => {
    const built = await mergeWorld();
    app = built.app;
    await delivered(built);
    const entries = await escalated('a');

    await pass(app);

    expect(await entries()).toEqual([['taken', skippedByEpic('already delivered: src/a.ts')]]);
  });

  it('still marks the task skipped when the host cannot close its merge request', async () => {
    const built = await mergeWorld();
    app = built.app;
    built.host.failClose = true;
    await delivered(built);

    await pass(app);

    expect(await statuses(app)).toEqual({ a: 'skipped' });
    expect(built.host.closed).toEqual([]);
  });

  it('closes the run of a task that ended already delivered, with the epic words as its reason', async () => {
    const built = await mergeWorld();
    app = built.app;
    await delivered(built);

    await pass(app);

    const run = await child(app, 'a');
    const { state, reason } = storedState(run);
    expect([state, reason?.message, run.workspace]).toEqual([
      'skipped',
      'skipped by its epic: already delivered: src/a.ts',
      'removed',
    ]);
    expect(actionsFor(state, reason?.code ?? null)).toEqual([]);
  });
});

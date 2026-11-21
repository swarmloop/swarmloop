import 'reflect-metadata';
import { RunSubtaskCommandsService } from '../../api/run-subtask-commands.service';
import { DocumentRepository } from '../../history/document.repository';
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

  it('still marks the task skipped when the host cannot close its merge request', async () => {
    const built = await mergeWorld();
    app = built.app;
    built.host.failClose = true;
    await delivered(built);

    await pass(app);

    expect(await statuses(app)).toEqual({ a: 'skipped' });
    expect(built.host.closed).toEqual([]);
  });
});

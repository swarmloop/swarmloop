import 'reflect-metadata';
import { ERROR_CODES } from '../../contract/error-codes';
import { RunRepository } from '../../history/run.repository';
import { REASON } from '../../contract/run-state';
import { writeRunState } from '../../history/run-state';
import type { TestApp } from '../../testing/test-app';
import {
  child,
  finish,
  parentState,
  pass,
  seedParent,
  setStatus,
  statuses,
  task,
  work,
  world,
} from './split-implement.spec-helpers';

async function store(app: TestApp, id: string, status: 'waiting' | 'blocked', code: string, retryAt?: string) {
  const run = await child(app, id);
  const reason = { code, message: `${code} message`, ...(retryAt ? { retryAt } : {}) };
  writeRunState(run, { status, currentStep: 'pipeline', reason });
  await app.app.get(RunRepository).saveRun(run);
}

describe('split implement, subtasks that heal or block', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  async function started(ids: string[]) {
    app = (await world()).app;
    await seedParent(
      app,
      ids.map((id) => task(id)),
    );
    await pass(app);
    for (const id of ids) await setStatus(app, id, 'running');
  }

  it.each([ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.DOCKER_UNAVAILABLE])(
    'makes the parent wait with the next try of a subtask that waits on %s',
    async (code) => {
      await started(['a']);
      await store(app, 'a', 'waiting', code, '2026-11-12T10:00:00.000Z');

      await pass(app);

      const parent = await parentState(app);
      expect(parent.state).toBe('waiting');
      expect(parent.reason).toMatchObject({ code: ERROR_CODES.SUBTASK_WAITING, retryAt: '2026-11-12T10:00:00.000Z' });
      expect(parent.reason?.message).toContain('next try at 2026-11-12T10:00:00.000Z');
    },
  );

  it('uses the earliest next try of the subtasks, also beside a subtask that runs', async () => {
    await started(['a', 'b', 'c']);
    await store(app, 'a', 'waiting', ERROR_CODES.HOST_UNAVAILABLE, '2026-11-12T10:30:00.000Z');
    await store(app, 'b', 'waiting', ERROR_CODES.DOCKER_UNAVAILABLE, '2026-11-12T10:10:00.000Z');
    await work(app, 'c');

    await pass(app);

    expect((await parentState(app)).reason?.retryAt).toBe('2026-11-12T10:10:00.000Z');
  });

  it('clears the next try when the subtask runs again, and goes on when it is merged', async () => {
    await started(['a']);
    await store(app, 'a', 'waiting', ERROR_CODES.HOST_UNAVAILABLE, '2026-11-12T10:00:00.000Z');
    await pass(app);

    await work(app, 'a');
    await pass(app);
    const healed = await parentState(app);
    expect(healed.reason?.code).toBe(ERROR_CODES.SUBTASKS_RUNNING);
    expect(healed.reason?.retryAt).toBeUndefined();

    await finish(app, 'a');
    await pass(app);
    expect(await statuses(app)).toEqual({ a: 'green' });
    expect((await parentState(app)).reason?.retryAt).toBeUndefined();
  });

  it.each([REASON.loopLimit, ERROR_CODES.SPEND_LIMIT, ERROR_CODES.PIPELINE_UNFIXED])(
    'blocks the parent with SUBTASK_BLOCKED for a subtask blocked with %s',
    async (code) => {
      await started(['a']);
      await store(app, 'a', 'blocked', code);

      await pass(app);

      const parent = await parentState(app);
      expect(parent.state).toBe('blocked');
      expect(parent.reason).toMatchObject({ code: ERROR_CODES.SUBTASK_BLOCKED });
      expect(parent.reason?.message).toContain('subtask a');
    },
  );
});

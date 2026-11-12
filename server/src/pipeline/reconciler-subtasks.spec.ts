import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';
import { Reconciler } from './reconciler';
import { SubtaskPort } from './subtask-port';

const KEY = 'PROJ-500';

/** A split parent that waits for one running subtask, with the fingerprint of its last pass recorded or not. */
async function waitingParent(app: TestApp, recorded: boolean) {
  const runs = app.app.get(RunRepository);
  const parent = await save(runs, KEY, 'implement', 'waiting');
  parent.split = true;
  writeRunState(parent, { status: 'waiting', reason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'running' } });
  await runs.saveRun(parent);
  const child = await save(runs, `${KEY}-a`, 'research', 'running');
  child.parentRunId = parent.id;
  child.taskId = 'a';
  await runs.saveRun(child);
  if (recorded) await runs.recordSubtaskFingerprint(parent, await runs.subtaskFingerprint(parent));
  return { runs, child };
}

describe('reconciler and the subtasks of a parent', () => {
  let app: TestApp;
  let resumed: jest.SpyInstance;

  beforeEach(async () => {
    app = await createTestApp();
    resumed = jest.spyOn(app.app.get(SubtaskPort), 'resumeParent').mockResolvedValue();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const ticks = async (count: number) => {
    for (let tick = 0; tick < count; tick++) await app.app.get(Reconciler).resumeSubtaskParents();
  };

  it('does not resume a waiting parent whose subtasks did not change', async () => {
    await waitingParent(app, true);

    await ticks(3);

    expect(resumed).not.toHaveBeenCalled();
  });

  it('resumes a parent once when a subtask changed without an event', async () => {
    const { runs, child } = await waitingParent(app, true);
    writeRunState(child, { status: 'done', currentStep: 'done' });
    await runs.saveRun(child);

    await ticks(1);

    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('resumes a parent with no fingerprint', async () => {
    await waitingParent(app, false);

    await ticks(1);

    expect(resumed).toHaveBeenCalledTimes(1);
  });
});

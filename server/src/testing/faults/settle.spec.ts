import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { RunFactsRepository } from '../../history/run-facts.repository';
import { RunRepository } from '../../history/run.repository';
import { startWaitColumns } from '../../history/run-state';
import { createTestApp, type TestApp } from '../test-app';
import { assertSettled, restartAndSettle, settle } from './settle.spec-helpers';

const NOW = '2026-11-12T10:00:00Z';
const WAIT = startWaitColumns({ code: 'AGENT_PLACE', message: 'Waiting for a free agent place (4 of 4 busy)' });

function task(backlogId: number, runKey: string): BacklogTaskRecord {
  return {
    backlogId,
    milestoneId: null,
    slug: 'ship',
    title: 'Ship the field',
    description: '',
    repositories: ['demo'],
    covers: [],
    depends: [],
    files: [],
    proof: [],
    manual: false,
    fixesMain: null,
    status: 'running',
    runKey,
    note: '',
    runNow: false,
    mergeOk: false,
    merged: {},
    madeBy: 'planner',
    position: 1,
    createdAt: NOW,
  };
}

describe('assertSettled', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => app.close());

  /** A running run whose agent start waits for a place, stored with its wait. */
  async function waitingRun(key: string): Promise<void> {
    const runs = app.app.get(RunRepository);
    await runs.openWaiting(key, '/target');
    await runs.change(key, (row) => {
      row.status = 'running';
    });
    const seen = (await runs.findRun(key))!;
    await app.app.get(RunFactsRepository).recordStartWait(seen, WAIT);
  }

  it('passes on a run that settled waiting with a named reason', async () => {
    await waitingRun('run-wait');
    await settle(app);
    await assertSettled(app);
  });

  it('passes on a backlog task whose run has a stored start wait that every place shows', async () => {
    await waitingRun('run-task');
    const backlogs = app.app.get(BacklogRepository);
    const backlog = await backlogs.saveBacklog({
      name: 'swarmloop',
      owner: 'ada',
      repositories: ['demo'],
      mergeMode: 'ok',
      paused: true,
      createdAt: NOW,
    });
    await backlogs.saveTask(task(backlog.id as number, 'run-task'));
    await assertSettled(app);
  });

  it('passes on the new process after a restart', async () => {
    await waitingRun('run-restart');
    app = await restartAndSettle(app);
    await assertSettled(app);
  });

  it('throws on a run left with a claim whose owner is dead, and names the run', async () => {
    const runs = app.app.get(RunRepository);
    await runs.openWaiting('run-dead', '/target');
    await runs.change('run-dead', (row) => {
      row.ownerPid = 2 ** 22 + 1;
    });
    await expect(assertSettled(app)).rejects.toThrow(/run-dead: holds a claim/);
  });
});

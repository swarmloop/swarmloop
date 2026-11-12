import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON, type StateReason } from '../contract/run-state';
import { StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { writeRunState } from '../history/run-state';
import { assertInvariants } from './flow-invariants';
import { save } from './runs.spec-helpers';
import { createTestApp, type TestApp } from './test-app';

const RETRY_AT = '2026-01-01T00:05:00.000Z';

const hostDown: StateReason = {
  code: ERROR_CODES.HOST_UNAVAILABLE,
  message: `github did not answer: HTTP 503; next try at ${RETRY_AT}`,
  retryAt: RETRY_AT,
};
const loopLimit: StateReason = {
  code: REASON.loopLimit,
  message: 'code-review ran 3 times (MAX_RETURNS); Resume starts another round',
};

interface Case {
  name: string;
  status: string;
  reason?: StateReason;
  /** The visit the run has, when it has one: its stored status. */
  visitStatus?: string;
  broken: boolean;
}

const cases: Case[] = [
  { name: 'a done run', status: 'done', visitStatus: 'done', broken: false },
  { name: 'a run that waits on a host with its next try', status: 'waiting', reason: hostDown, broken: false },
  { name: 'a run blocked on the loop limit', status: 'blocked', reason: loopLimit, broken: false },
  {
    name: 'a blocked run with a code that is not on the list',
    status: 'blocked',
    reason: { code: 'MYSTERY', message: 'blocked' },
    broken: true,
  },
  {
    name: 'a run that waits on a host with no next try',
    status: 'waiting',
    reason: { ...hostDown, retryAt: undefined },
    broken: true,
  },
  { name: 'a started run that waits with no reason', status: 'waiting', visitStatus: 'done', broken: true },
  { name: 'a visit that ended with no result', status: 'done', visitStatus: '', broken: true },
];

describe('assertInvariants', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(cases.map((item) => [item.name, item] as const))('%s', async (_name, item) => {
    const runs = app.app.get(RunRepository);
    const run = await save(runs, 'PROJ-900', 'implement', item.status);
    writeRunState(run, { status: item.status, reason: item.reason });
    await runs.saveRun(run);
    if (item.visitStatus !== undefined) {
      const now = new Date().toISOString();
      await app.app.get(VisitRepository).saveStat(
        Object.assign(new StepStatEntity(), {
          runId: run.id,
          step: 'implement',
          attempt: 1,
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          status: item.visitStatus,
        }),
      );
    }

    const check = assertInvariants(app);

    if (item.broken) await expect(check).rejects.toThrow(run.key);
    else await expect(check).resolves.toBeUndefined();
  });
});

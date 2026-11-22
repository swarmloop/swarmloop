import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON, type StateReason } from '../contract/run-state';
import { StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
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

  describe('the starts of a run', () => {
    let attempt = 0;
    const seed = async (rows: { by?: string; digest?: string | null; reason?: string | null; rerun?: boolean }[]) => {
      const run = await save(app.app.get(RunRepository), 'PROJ-901', 'implement', 'done');
      for (const row of rows) {
        attempt += 1;
        await app.app.get(VisitStartRepository).note({
          runId: run.id,
          step: 'implement',
          attemptId: `attempt-${attempt}`,
          startedBy: row.by ?? 'machine',
          level: null,
          inputDigest: row.digest === undefined ? 'd1' : row.digest,
          startReason: row.reason ?? null,
          rerunUnfinished: row.rerun ?? false,
          createdAt: new Date().toISOString(),
        });
      }
      return run;
    };

    it('passes for a run with no starts', async () => {
      await seed([]);
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it.each([
      ['person starts on one input', [{ by: 'person' }, { by: 'person' }]],
      ['machine starts with no digest', [{ digest: null }, { digest: null }]],
      ['a machine start on another input', [{}, { digest: 'd2' }]],
      ['a rerun of an unfinished visit', [{}, { rerun: true }]],
    ])('passes for %s', async (_name, rows) => {
      await seed(rows);
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it('throws for two machine or planner starts on one input', async () => {
      const run = await seed([{ by: 'planner' }, {}]);
      await expect(assertInvariants(app)).rejects.toThrow(`${run.key} implement was started again on the same input`);
    });

    it('throws for a machine start of a stopped run', async () => {
      const run = await seed([{ reason: 'STOPPED', digest: null }]);
      await expect(assertInvariants(app)).rejects.toThrow(
        `${run.key} implement was started by the machine on a stopped run`,
      );
    });
  });
});

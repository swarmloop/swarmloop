import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { storeRun } from './store-run.spec-helpers';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON, type StateReason } from '../contract/run-state';
import { AgentCallRepository } from '../history/agent-call.repository';
import { StepStatEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
import { writeRunState } from '../history/run-state';
import { assertInvariants } from './flow-invariants';
import { loggedCall, save } from './runs.spec-helpers';
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
    await storeRun(runs, run);
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

  describe('the stored state of a run', () => {
    const askingRun = async () => {
      const run = await save(app.app.get(RunRepository), 'PROJ-902', 'research', 'waiting');
      await app.app.get(DocumentRepository).putDocument(run, 'questions', '- which store\n');
      return run;
    };

    it('passes when the stored state is what the row and its open items say', async () => {
      await askingRun();
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it('throws when the stored state differs from what the row and its open items say', async () => {
      const run = await askingRun();
      await app.app.get(DataSource).query(`UPDATE runs SET state = 'idle', state_reason = NULL WHERE id = ?`, [run.id]);
      await expect(assertInvariants(app)).rejects.toThrow(`${run.key} stores idle`);
    });
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

  describe('the start of an agent visit', () => {
    const seed = async (visit: {
      attemptId: string | null;
      status?: string;
      killReason?: string;
      exchange?: boolean;
    }) => {
      const run = await save(app.app.get(RunRepository), 'PROJ-902', 'implement', 'done');
      const now = new Date().toISOString();
      const visits = app.app.get(VisitRepository);
      const stat = Object.assign(new StepStatEntity(), {
        runId: run.id,
        step: 'implement',
        attempt: 1,
        attemptId: visit.attemptId,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: visit.status ?? 'done',
        killReason: visit.killReason ?? null,
      });
      await visits.saveStat(stat);
      if (visit.exchange !== false) {
        await app.app.get(AgentCallRepository).linkVisit(
          [
            await loggedCall(app.app.get(AgentCallRepository), {
              model: 'm',
              startedAt: now,
              finishedAt: now,
              durationMs: 0,
              requestText: 'ask',
              responseText: '',
            }),
          ],
          stat.id,
        );
      }
      return { run, stat };
    };
    const start = (runId: number, attemptId: string, statId: number | null) =>
      app.app.get(VisitStartRepository).note({
        runId,
        step: 'implement',
        attemptId,
        startedBy: 'person',
        level: null,
        inputDigest: null,
        startReason: null,
        rerunUnfinished: false,
        createdAt: new Date().toISOString(),
        outside: statId !== null,
        statId,
      });

    it('throws for an agent visit with no start', async () => {
      const { run, stat } = await seed({ attemptId: 'a-1' });
      await expect(assertInvariants(app)).rejects.toThrow(`${run.key} visit ${stat.id} of implement has no start`);
    });

    it('passes for a visit whose start has its attempt', async () => {
      const { run } = await seed({ attemptId: 'a-1' });
      await start(run.id, 'a-1', null);
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it('passes for a visit that an outside start linked by its stat', async () => {
      const { run, stat } = await seed({ attemptId: null });
      await start(run.id, 'start-1', stat.id);
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it('passes for a visit that ended on a provider limit and for one with no exchange', async () => {
      await seed({ attemptId: 'a-1', status: 'interrupted', killReason: ERROR_CODES.RUNTIME_LIMIT });
      await seed({ attemptId: 'a-2', exchange: false });
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });
  });

  describe('a rebase conflict', () => {
    const journalOf = (checkpoint: string, generation: number) =>
      JSON.stringify({ demo: { path: '/w', branch: 'b', checkpoint, generation } });
    const seed = async (options: {
      status: string;
      reason?: StateReason;
      marker?: string;
      checkpoint: string;
      step?: string;
    }) => {
      const runs = app.app.get(RunRepository);
      const run = await save(runs, 'PROJ-903', options.step ?? 'implement', options.status);
      writeRunState(run, { status: options.status, currentStep: options.step ?? 'implement', reason: options.reason });
      await storeRun(runs, run);
      const documents = app.app.get(DocumentRepository);
      if (options.marker) await documents.putDocument(run, 'rebase_conflict', options.marker);
      await documents.putDocument(run, 'rebase_journal', journalOf(options.checkpoint, run.generation));
      return run;
    };
    const conflictBlock: StateReason = {
      code: ERROR_CODES.REBASE_CONFLICT,
      message: 'demo conflicts with main; Replay starts the work again',
    };

    it('throws for a run blocked REBASE_CONFLICT on a conflict parked for implement', async () => {
      const run = await seed({
        status: 'blocked',
        reason: conflictBlock,
        marker: 'pending-implement\n',
        checkpoint: 'conflict',
      });
      await expect(assertInvariants(app)).rejects.toThrow(
        `${run.key} is blocked on a rebase conflict that implement or a planner holds`,
      );
    });

    it('throws for a run failed at implement on a parked conflict', async () => {
      const run = await seed({ status: 'failed', marker: 'pending\n', checkpoint: 'conflict' });
      await expect(assertInvariants(app)).rejects.toThrow(
        `${run.key} is failed on a rebase conflict that implement or a planner holds`,
      );
    });

    it('passes for a run that waits for its planner with a parked conflict', async () => {
      await seed({
        status: 'waiting',
        reason: { code: REASON.asksPlanner, message: 'implement asked its planner' },
        marker: 'pending-implement\n',
        checkpoint: 'conflict',
      });
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it('passes for the block of a recreated worktree, whose journal is at applying', async () => {
      await seed({ status: 'blocked', reason: conflictBlock, checkpoint: 'applying' });
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });

    it('passes for a task blocked under its own code with a parked conflict', async () => {
      await seed({
        status: 'blocked',
        reason: { code: ERROR_CODES.PIPELINE_UNFIXED, message: 'the pipeline stays red; Resume tries again' },
        marker: 'pending-implement\n',
        checkpoint: 'conflict',
        step: 'pipeline',
      });
      await expect(assertInvariants(app)).resolves.toBeUndefined();
    });
  });
});

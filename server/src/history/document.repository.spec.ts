import { DataSource } from 'typeorm';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { seedBacklogTask } from '../steps/shared/question-holds.spec-helpers';
import { storedState } from './run-state';
import { DocumentRepository } from './document.repository';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

describe('DocumentRepository', () => {
  it('creates, reads and replaces the latest document without duplicate bodies', async () => {
    const db = await repositoryDatabase();
    try {
      const documents = db.app.get(DocumentRepository);
      const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
      expect(await documents.latestDocument('missing', 'requirements')).toBeNull();
      expect(await documents.hasDocument('missing', 'requirements')).toBe(false);
      await documents.putDocument(run, 'requirements', 'first');
      expect(await documents.latestBody(run.key, 'requirements')).toBe('first');
      expect(await documents.hasDocument(run.key, 'requirements')).toBe(true);
      await documents.putDocument(run, 'requirements', 'first');
      expect(await documents.listDocuments(run.id)).toHaveLength(1);
      await documents.putDocument(run, 'requirements', 'updated');
      const rows = await documents.listDocuments(run.id);
      expect(rows.map((row) => row.body)).toEqual(['first', 'updated']);
      expect(await documents.latestDocument(run.key, 'requirements')).toEqual({ id: rows[1].id, body: 'updated' });
      expect(await documents.bodyBefore(run.key, 'requirements', rows[1].id)).toBe('first');
      expect(await documents.bodyBefore(run.key, 'requirements', rows[0].id)).toBeNull();
      await documents.putDocument(run, 'git_refusal', 'a\n1');
      await documents.putDocument(run, 'git_refusal', 'b\n2');
      expect(await documents.bodiesOfKind(run.id, 'git_refusal')).toEqual(['a\n1', 'b\n2']);
      expect(await documents.bodyBefore('missing', 'requirements', rows[1].id)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('reads only the latest document of the asked kinds for each of the asked runs', async () => {
    const db = await repositoryDatabase();
    try {
      const documents = db.app.get(DocumentRepository);
      const runs = db.app.get(RunRepository);
      const first = await runs.openWaiting('run-1', '/target');
      const second = await runs.openWaiting('run-2', '/target');
      const other = await runs.openWaiting('run-3', '/target');
      await documents.putDocument(first, 'subtasks', 'old plan');
      await documents.putDocument(first, 'subtasks', 'new plan');
      await documents.putDocument(first, 'error', 'first error');
      await documents.putDocument(first, 'contract', 'not asked for');
      await documents.putDocument(second, 'error', 'second error');
      await documents.putDocument(other, 'subtasks', 'not asked run');

      const found = await documents.latestDocuments([first.id, second.id], ['subtasks', 'error']);

      expect(found.map(({ runId, kind, body }) => [runId, kind, body])).toEqual([
        [first.id, 'subtasks', 'new plan'],
        [first.id, 'error', 'first error'],
        [second.id, 'error', 'second error'],
      ]);
      // More runs than the 999 variables an older SQLite takes in one statement.
      const many = [first.id, ...Array.from({ length: 1500 }, (_, n) => 10_000 + n)];
      expect((await documents.latestDocuments(many, ['subtasks'])).map(({ body }) => body)).toEqual(['new plan']);
      expect(await documents.latestDocuments([], ['subtasks'])).toEqual([]);
      expect(await documents.latestDocuments([other.id], ['error'])).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it('plans the latest documents of runs on the run, kind and id index without scanning documents', async () => {
    const db = await repositoryDatabase();
    try {
      const documents = db.app.get(DocumentRepository);
      const runs = db.app.get(RunRepository);
      const dataSource = db.app.get(DataSource);
      const first = await runs.openWaiting('run-1', '/target');
      const second = await runs.openWaiting('run-2', '/target');
      await documents.putDocument(first, 'subtasks', 'plan');
      await documents.putDocument(second, 'error', 'failed');
      const runner = dataSource.createQueryRunner();
      const prototype = Object.getPrototypeOf(runner) as { query: (sql: string, parameters?: unknown[]) => unknown };
      await runner.release();
      const sent: { sql: string; parameters: unknown[] }[] = [];
      const original = prototype.query;
      const spy = jest.spyOn(prototype, 'query').mockImplementation(function (
        this: unknown,
        sql: string,
        parameters?: unknown[],
        ...rest: unknown[]
      ) {
        sent.push({ sql, parameters: parameters ?? [] });
        return (original as (...args: unknown[]) => unknown).call(this, sql, parameters, ...rest);
      });
      try {
        await documents.latestDocuments([first.id, second.id], ['subtasks', 'error']);
      } finally {
        spy.mockRestore();
      }
      const grouped = sent.find(({ sql }) => sql.includes('MAX('));
      expect(grouped).toBeDefined();
      const plan: { detail: string }[] = await dataSource.query(
        `EXPLAIN QUERY PLAN ${grouped?.sql}`,
        grouped?.parameters,
      );
      const details = plan.map(({ detail }) => detail);
      expect(details.some((detail) => detail.includes('USING COVERING INDEX IDX_documents_run_kind_id'))).toBe(true);
      expect(details.some((detail) => detail.startsWith('SCAN documents') || detail.startsWith('SCAN document'))).toBe(
        false,
      );
    } finally {
      await db.close();
    }
  });

  describe('stores the state with a document of an open-item kind', () => {
    const waitingAtResearch = async (db: Awaited<ReturnType<typeof repositoryDatabase>>, key: string) => {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting(key, '/target');
      return runs.change(key, (run) => {
        run.currentStep = 'research';
      });
    };
    const stateOf = async (db: Awaited<ReturnType<typeof repositoryDatabase>>, key: string) => {
      const { state, reason } = storedState((await db.app.get(RunRepository).findRun(key))!);
      return [state, reason?.code ?? null];
    };

    it('says waiting for a person right after a question is stored, and idle once the run is past its questions', async () => {
      const db = await repositoryDatabase();
      try {
        const documents = db.app.get(DocumentRepository);
        const run = await waitingAtResearch(db, 'run-1');
        await documents.putDocument(run, 'questions', '- Which store?\n');
        expect(await stateOf(db, 'run-1')).toEqual(['waiting', 'NEEDS_ANSWERS']);
        await db.app.get(RunRepository).change('run-1', (row) => {
          row.currentStep = 'implement';
        });
        expect(await stateOf(db, 'run-1')).toEqual(['idle', null]);
      } finally {
        await db.close();
      }
    });

    it('says waiting for the planner for a backlog task run', async () => {
      const db = await repositoryDatabase();
      try {
        await seedBacklogTask(db.app, 'going-1');
        const documents = db.app.get(DocumentRepository);
        const run = await waitingAtResearch(db, 'going-1');
        await documents.putDocument(run, 'questions', '- Which store?\n');
        expect(await stateOf(db, 'going-1')).toEqual(['waiting', 'ASKS_PLANNER']);
      } finally {
        await db.close();
      }
    });

    it('stops the walk up the parents at a run that is its own parent', async () => {
      const db = await repositoryDatabase();
      try {
        const run = await waitingAtResearch(db, 'run-1');
        await db.app.get(RunRepository).change('run-1', (row) => {
          row.parentRunId = row.id;
        });
        await db.app.get(DocumentRepository).putDocument(run, 'questions', '- Which store?\n');
        expect(await stateOf(db, 'run-1')).toEqual(['waiting', 'NEEDS_ANSWERS']);
      } finally {
        await db.close();
      }
    });

    it('says waiting for a person for a backlog task run whose question is passed on', async () => {
      const db = await repositoryDatabase();
      try {
        await seedBacklogTask(db.app, 'going-1');
        const documents = db.app.get(DocumentRepository);
        const run = await waitingAtResearch(db, 'going-1');
        const line = { question: 'Which store?', line: 'Only you can choose.', at: '2026-01-01T00:00:00.000Z' };
        await documents.putDocument(run, ARTIFACTS.passedOn.kind, ARTIFACTS.passedOn.format([line]));
        await documents.putDocument(run, 'questions', '- Which store?\n');
        expect(await stateOf(db, 'going-1')).toEqual(['waiting', 'NEEDS_ANSWERS']);
      } finally {
        await db.close();
      }
    });

    it('corrects the state for a document of an open-item kind only', async () => {
      const db = await repositoryDatabase();
      try {
        const documents = db.app.get(DocumentRepository);
        const run = await waitingAtResearch(db, 'run-1');
        await documents.putDocument(run, 'questions', '- Which store?\n');
        await db.app.get(DataSource).query("UPDATE runs SET state = 'idle', state_reason = NULL");
        await documents.putDocument(run, 'git_refusal', 'a');
        expect(await stateOf(db, 'run-1')).toEqual(['idle', null]);
        await documents.putDocument(run, 'questions', '- Which store?\n- And where?\n');
        expect(await stateOf(db, 'run-1')).toEqual(['waiting', 'NEEDS_ANSWERS']);
      } finally {
        await db.close();
      }
    });
  });
});

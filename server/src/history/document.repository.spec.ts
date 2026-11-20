import { DataSource } from 'typeorm';
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
  it('reads the latest body of a kind of each run in one query', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const documents = db.app.get(DocumentRepository);
      const first = await runs.openWaiting('run-1', '/target');
      const second = await runs.openWaiting('run-2', '/target');
      await documents.putDocument(first, 'requirements', 'old');
      await documents.putDocument(first, 'requirements', 'new');
      await documents.putDocument(first, 'error', 'not asked for');
      await documents.putDocument(second, 'error', 'other kind');

      expect([...(await documents.latestBodies([first.id, second.id], 'requirements'))]).toEqual([[first.id, 'new']]);
      expect((await documents.latestBodies([], 'requirements')).size).toBe(0);
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
});

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
    } finally {
      await db.close();
    }
  });
});

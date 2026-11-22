import { repositoryDatabase } from './repository.spec-helpers';
import { VisitStartRepository, type VisitStartDraft } from './visit-start.repository';

const start = (attemptId: string, overrides: Partial<VisitStartDraft> = {}): VisitStartDraft => ({
  runId: 1,
  step: 'implement',
  attemptId,
  startedBy: 'machine',
  level: null,
  inputDigest: 'digest',
  startReason: null,
  rerunUnfinished: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('VisitStartRepository', () => {
  it('notes starts and reads a run back in id order, each by its attempt id', async () => {
    const db = await repositoryDatabase();
    try {
      const starts = db.app.get(VisitStartRepository);
      await starts.note(start('a-1'));
      await starts.note(start('a-2', { startedBy: 'planner', level: 1, inputDigest: null, rerunUnfinished: true }));
      await starts.note(start('other', { runId: 2 }));
      const rows = await starts.forRun(1);
      expect(rows.map((row) => row.attemptId)).toEqual(['a-1', 'a-2']);
      expect(rows[1]).toMatchObject({ startedBy: 'planner', level: 1, inputDigest: null, rerunUnfinished: true });
      expect(rows[0].rerunUnfinished).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('refuses a second start with the same attempt id', async () => {
    const db = await repositoryDatabase();
    try {
      const starts = db.app.get(VisitStartRepository);
      await starts.note(start('a-1'));
      await expect(starts.note(start('a-1'))).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});

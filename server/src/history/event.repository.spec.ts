import { EventRepository } from './event.repository';
import { readLoopDetail } from './loop-detail';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { VisitRepository } from './visit.repository';

describe('EventRepository', () => {
  it('records and reads loops, then appends the next attempt and reads visit HTTP calls', async () => {
    const db = await repositoryDatabase();
    try {
      const events = db.app.get(EventRepository);
      const run = await db.app.get(RunRepository).begin('run-1', 'code-review');
      await events.recordLoop(run, 'review', 1, 'first');
      expect(await events.listLoops(run.id)).toEqual([
        expect.objectContaining({ counter: 'review', attempt: 1, reason: 'first' }),
      ]);
      await events.recordLoop(run, 'review', 2, 'updated');
      expect((await events.listLoops(run.id)).map((row) => row.attempt)).toEqual([1, 2]);
      const visit = repositoryVisit();
      visit.httpCalls.push({
        provider: 'other',
        method: 'GET',
        url: 'https://example.test',
        statusCode: 200,
        durationMs: 10,
        error: null,
      });
      const stat = await db.app.get(VisitRepository).finishVisit(run, visit);
      expect(await events.listHttpCalls(run.id)).toEqual([
        expect.objectContaining({ runId: run.id, stepStatId: stat.id, statusCode: 200 }),
      ]);
    } finally {
      await db.close();
    }
  });

  it('stores the detail of a return as JSON, and null when there is none', async () => {
    const db = await repositoryDatabase();
    try {
      const events = db.app.get(EventRepository);
      const run = await db.app.get(RunRepository).begin('run-2', 'checks');
      await events.recordLoop(run, 'checks', 1, 'required checks failed', { commands: ['npm test'] });
      await events.recordLoop(run, 'checks', 2, 'required checks failed');
      const [first, second] = await events.listLoops(run.id);
      expect(readLoopDetail(first.detail)).toEqual({ commands: ['npm test'] });
      expect(second.detail).toBeNull();
    } finally {
      await db.close();
    }
  });
});

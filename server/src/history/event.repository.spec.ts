import { EventRepository } from './event.repository';
import { HistoryService } from './history.service';
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
      expect(await db.app.get(HistoryService).listLoops(run.id)).toEqual([
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
});

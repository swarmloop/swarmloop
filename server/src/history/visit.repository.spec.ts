import { DocumentRepository } from './document.repository';
import { HistoryService } from './history.service';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { VisitRepository } from './visit.repository';

describe('VisitRepository', () => {
  it('creates a visit with related rows, reads it and updates its stat', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const runs = db.app.get(RunRepository);
      const run = await runs.begin('run-1', 'code-review');
      const stat = await visits.finishVisit(run, repositoryVisit());
      expect(await db.app.get(HistoryService).listStats(run.id)).toEqual([stat]);
      expect(await visits.listSamples([stat.id])).toEqual([
        expect.objectContaining({ stepStatId: stat.id, cpuPercent: 10, rssBytes: 100 }),
      ]);
      expect(await visits.listExchanges([stat.id])).toEqual([
        expect.objectContaining({ stepStatId: stat.id, chatId: 'chat-1' }),
      ]);
      expect(await visits.latestChatId(run.id)).toBe('chat-1');
      expect(await visits.tokenTotal(run.id)).toBe(5);
      expect(await visits.codeReviewReportMs(run.id)).toEqual(new Map([[stat.id, 1000]]));
      expect(await runs.durationByRun()).toEqual(new Map([[run.id, 1000]]));
      expect(await db.app.get(DocumentRepository).latestBody(run.key, 'review_report')).toBe('first report');
      stat.tokensOut = 8;
      await visits.saveStat(stat);
      expect((await visits.listStats(run.id))[0].tokensOut).toBe(8);
      expect(await visits.tokenTotal(run.id)).toBe(10);
      const second = await visits.finishVisit(run, repositoryVisit());
      expect(second.attempt).toBe(2);
      expect(await db.app.get(DocumentRepository).listDocuments(run.id)).toHaveLength(1);
      expect(await visits.listSamples([])).toEqual([]);
      expect(await visits.listExchanges([])).toEqual([]);
      expect(await visits.latestChatId(0)).toBeNull();
    } finally {
      await db.close();
    }
  });
});

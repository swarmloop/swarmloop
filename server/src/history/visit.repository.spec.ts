import { DocumentRepository } from './document.repository';
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
      expect(await visits.listStats(run.id)).toEqual([stat]);
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

  it('records the runtime of the agent next to its model, and null for a visit that names none', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-1', 'code-review');
      await visits.finishVisit(run, { ...repositoryVisit(), runtime: 'codex', model: 'gpt-6.1-sol' });
      await visits.finishVisit(run, repositoryVisit());
      const stats = await visits.listStats(run.id);
      expect(stats.map((stat) => stat.runtime)).toEqual(['codex', null]);
      expect(stats[0].model).toBe('gpt-6.1-sol');
    } finally {
      await db.close();
    }
  });
});

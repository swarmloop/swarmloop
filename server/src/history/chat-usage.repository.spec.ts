import type { VisitDraft } from './visit';
import { ChatUsageRepository } from './chat-usage.repository';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { VisitRepository } from './visit.repository';

function visitOn(chats: string[], usd: number, tokensIn: number, tokensOut: number): VisitDraft {
  const base = repositoryVisit();
  const exchange = (chatId: string) => ({ ...(base.exchange as NonNullable<VisitDraft['exchange']>), chatId });
  return {
    ...base,
    usd,
    tokensIn,
    tokensOut,
    document: null,
    exchange: exchange(chats[0] ?? ''),
    exchanges: chats.map(exchange),
  };
}

describe('ChatUsageRepository', () => {
  it('sums the stored visits of one chat, a visit with several exchanges on it once', async () => {
    const db = await repositoryDatabase();
    try {
      const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const visits = db.app.get(VisitRepository);
      await visits.finishVisit(run, visitOn(['chat-a'], 1.5, 100, 10));
      await visits.finishVisit(run, visitOn(['chat-a', 'chat-a'], 0.5, 40, 5));
      await visits.finishVisit(run, visitOn(['chat-b'], 9, 900, 90));
      const usage = db.app.get(ChatUsageRepository);
      expect(await usage.totalsOf('chat-a')).toEqual({ usd: 2, tokensIn: 140, tokensOut: 15 });
      expect(await usage.totalsOf('chat-b')).toEqual({ usd: 9, tokensIn: 900, tokensOut: 90 });
      expect(await usage.totalsOf('chat-new')).toEqual({ usd: 0, tokensIn: 0, tokensOut: 0 });
    } finally {
      await db.close();
    }
  });

  it("gives the reported totals of the chat's latest exchange, none when it has none", async () => {
    const db = await repositoryDatabase();
    try {
      const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const visits = db.app.get(VisitRepository);
      const reported = (usd: number) => ({ usd, tokensIn: usd * 100, tokensOut: usd * 10 });
      const on = (chat: string, totals: ReturnType<typeof reported> | null): VisitDraft => {
        const draft = visitOn([chat], 1, 1, 1);
        const exchange = { ...(draft.exchange as NonNullable<VisitDraft['exchange']>), reported: totals };
        return { ...draft, exchange, exchanges: [exchange] };
      };
      await visits.finishVisit(run, on('chat-a', reported(1.37)));
      await visits.finishVisit(run, on('chat-a', reported(0.1)));
      await visits.finishVisit(run, on('chat-b', reported(5)));
      await visits.finishVisit(run, on('chat-b', null));
      const usage = db.app.get(ChatUsageRepository);
      expect(await usage.lastReportedOf('chat-a')).toEqual(reported(0.1));
      expect(await usage.lastReportedOf('chat-b')).toBeNull();
      expect(await usage.lastReportedOf('chat-new')).toBeNull();
    } finally {
      await db.close();
    }
  });
});

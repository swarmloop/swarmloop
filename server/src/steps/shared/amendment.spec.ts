import { PLAN_CHAT_KIND, type PlanChatLog, type PlanRevision } from '../../contract/plan-chat';
import { DocumentRepository } from '../../history/document.repository';
import { repositoryDatabase, repositoryVisit } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { amendmentOf } from './amendment';

const revision = (version: number, at: string): PlanRevision => ({
  version,
  reason: `reason ${version}`,
  summary: 'Added 1 item',
  added: [`item ${version}`],
  changed: [],
  dropped: [],
  at,
});
const chat = (...revisions: PlanRevision[]): string =>
  `${JSON.stringify({ entries: [], revisions } satisfies PlanChatLog)}\n`;

describe('amendmentOf', () => {
  async function setup() {
    const db = await repositoryDatabase();
    const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
    const visits = db.app.get(VisitRepository);
    const implemented = (status: string, finishedAt: string) =>
      visits.finishVisit(run, { ...repositoryVisit(), step: 'implement', status, finishedAt });
    return { db, run, documents: db.app.get(DocumentRepository), visits, implemented };
  }

  it('gives the revisions written after the latest implement visit that finished ok', async () => {
    const { db, run, documents, visits, implemented } = await setup();
    try {
      await implemented('done', '2026-01-02T00:00:00.000Z');
      await documents.putDocument(
        run,
        PLAN_CHAT_KIND,
        chat(revision(2, '2026-01-01T00:00:00.000Z'), revision(3, '2026-01-03T00:00:00.000Z')),
      );
      expect((await amendmentOf(documents, visits, run)).map((item) => item.version)).toEqual([3]);
      await implemented('failed', '2026-01-04T00:00:00.000Z');
      expect((await amendmentOf(documents, visits, run)).map((item) => item.version)).toEqual([3]);
      await implemented('done', '2026-01-05T00:00:00.000Z');
      expect(await amendmentOf(documents, visits, run)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('gives none for a run that did not implement', async () => {
    const { db, run, documents, visits } = await setup();
    try {
      await documents.putDocument(run, PLAN_CHAT_KIND, chat(revision(2, '2026-01-03T00:00:00.000Z')));
      expect(await amendmentOf(documents, visits, run)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

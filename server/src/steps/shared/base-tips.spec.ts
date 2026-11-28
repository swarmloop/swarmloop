import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { runJournal } from './rebase-journal';
import { BaseTips } from './base-tips';

const ENTRY = { path: '/w', branch: 'feature/x', fingerprint: 'f', protectRef: 'r', expectedRemoteTip: null };

async function setup() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const parent = await runs.openWaiting('p-1', '/target');
  const part = await runs.openSubtask('p-1-a', parent.id, 'a');
  return { db, runs, documents, parent, part, tips: new BaseTips(runs, documents) };
}

describe('BaseTips', () => {
  it('knows the recorded tip of a repository', async () => {
    const { db, runs, part, tips } = await setup();
    try {
      await tips.record(part, { web: 'aaa' });

      expect(await tips.known((await runs.findRun(part.key))!, ['web', 'api'])).toEqual({ web: ['aaa'], api: [] });
    } finally {
      await db.close();
    }
  });

  it('takes the completed bases of the run and the old heads of its parent when none was recorded', async () => {
    const { db, documents, parent, part, tips } = await setup();
    try {
      const own = runJournal(documents, part);
      await own.put('web', { ...ENTRY, oldHead: 'o1', baseSha: 'b1', checkpoint: 'completed' });
      await own.put('web', { ...ENTRY, oldHead: 'o2', baseSha: 'b2', checkpoint: 'conflict' });
      const epic = runJournal(documents, parent);
      await epic.put('web', { ...ENTRY, oldHead: 'old-epic', baseSha: 'main-tip', checkpoint: 'completed' });

      const known = await tips.known(part, ['web']);

      expect(known.web?.slice().sort()).toEqual(['b1', 'main-tip', 'old-epic']);
    } finally {
      await db.close();
    }
  });

  it('records only the bases of repositories a move applied and has not completed', async () => {
    const { db, runs, documents, part, tips } = await setup();
    try {
      const journal = runJournal(documents, part);
      await journal.put('web', { ...ENTRY, oldHead: 'o', baseSha: 'applied-base', checkpoint: 'applied' });
      await journal.put('api', { ...ENTRY, oldHead: 'o', baseSha: 'done-base', checkpoint: 'completed' });
      await journal.put('docs', { ...ENTRY, oldHead: 'o', baseSha: 'parked-base', checkpoint: 'conflict' });

      await tips.recordMoved(part, journal);

      expect((await runs.findRun(part.key))?.baseTips).toEqual({ web: 'applied-base' });
    } finally {
      await db.close();
    }
  });

  it('takes a move of the own edits onto the feature branch for no base the run stands on', async () => {
    const { db, runs, documents, part, tips } = await setup();
    try {
      await tips.record(part, { web: 'main-tip' });
      const journal = runJournal(documents, part);
      await journal.put('web', {
        ...ENTRY,
        oldHead: 'o',
        baseSha: 'feature-tip',
        ownEdits: true,
        checkpoint: 'applied',
      });

      await tips.recordMoved((await runs.findRun(part.key))!, journal);
      await journal.advance('web', 'completed');

      const run = (await runs.findRun(part.key))!;
      expect(run.baseTips).toEqual({ web: 'main-tip' });
      expect((await tips.known(run, ['web'])).web).toEqual(['main-tip']);
    } finally {
      await db.close();
    }
  });

  it('knows no base from the completed own edits of a run that recorded none', async () => {
    const { db, documents, part, tips } = await setup();
    try {
      const journal = runJournal(documents, part);
      await journal.put('web', {
        ...ENTRY,
        oldHead: 'o',
        baseSha: 'feature-tip',
        ownEdits: true,
        checkpoint: 'completed',
      });

      expect((await tips.known(part, ['web'])).web).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

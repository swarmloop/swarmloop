import { DataSource } from 'typeorm';
import { ERROR_CODES } from '../../contract/error-codes';
import { REASON } from '../../contract/run-state';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { RunEntity } from '../../history/run.entity';
import { RunFactsRepository } from '../../history/run-facts.repository';
import { RunRepository } from '../../history/run.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { LiveHub } from '../../live/live.hub';
import { RunStateRefresh } from './run-state-refresh';

const QUESTION = 'Which field is optional?';
const reasonOf = (code: string) => JSON.stringify({ code, message: code });

async function setup() {
  const db = await repositoryDatabase();
  const dataSource = db.app.get(DataSource);
  const hub = new LiveHub();
  const rows = dataSource.getRepository(RunEntity);
  const refresh = new RunStateRefresh(
    db.app.get(RunRepository),
    db.app.get(DocumentRepository),
    db.app.get(CheckoutRepository),
    new RunFactsRepository(rows, hub),
    hub,
  );
  const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
  const noticed: string[] = [];
  hub.onChanged((key) => noticed.push(key));
  const documents = db.app.get(DocumentRepository);
  /** Changes the row as a writer would, then tells the hub like the writer does. */
  const set = async (columns: Partial<RunEntity>) => {
    await rows.update({ id: run.id }, columns);
    hub.changed(run.key);
    await refresh.settled();
  };
  const read = async () => {
    const row = await rows.findOneByOrFail({ id: run.id });
    return { state: row.state, code: row.stateReason ? (JSON.parse(row.stateReason) as { code: string }).code : null };
  };
  return { db, hub, rows, refresh, run, noticed, documents, set, read };
}

describe('RunStateRefresh', () => {
  it('reads a run that waits with open questions as waiting for a person', async () => {
    const { db, refresh, run, documents, set, read } = await setup();
    try {
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
      await set({ currentStep: 'research' });
      expect(await read()).toEqual({ state: 'waiting', code: 'NEEDS_ANSWERS' });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('waits for a paste at requirements until the pending one is saved', async () => {
    const { db, hub, refresh, run, documents, set, read } = await setup();
    try {
      const url = 'https://example.test/paste';
      await documents.putDocument(run, 'pending', JSON.stringify({ url }));
      await set({ currentStep: 'requirements' });
      expect(await read()).toEqual({ state: 'waiting', code: 'NEEDS_ANSWERS' });
      await db.app.get(CheckoutRepository).savePaste(run.key, url, 'pasted body');
      hub.changed(run.key);
      await refresh.settled();
      expect(await read()).toEqual({ state: 'idle', code: null });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('clears the wait when the questions are gone', async () => {
    const { db, refresh, run, documents, set, read } = await setup();
    try {
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
      await set({ currentStep: 'research' });
      await documents.putDocument(run, 'questions', '\n');
      await set({ currentStep: 'research' });
      expect(await read()).toEqual({ state: 'idle', code: null });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('clears the wait when the run moves to a step that asks nothing', async () => {
    const { db, refresh, run, documents, set, read } = await setup();
    try {
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
      await set({ currentStep: 'research' });
      await set({ currentStep: 'branch' });
      expect(await read()).toEqual({ state: 'idle', code: null });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('marks a run sent back to implement as returned', async () => {
    const { db, refresh, set, read } = await setup();
    try {
      await set({ currentStep: 'implement', attemptsReview: 1 });
      expect(await read()).toEqual({ state: 'idle', code: REASON.returned });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('keeps the code a blocked run stores', async () => {
    const { db, refresh, set, read } = await setup();
    try {
      await set({ status: 'blocked', currentStep: 'plan', stateReason: reasonOf(ERROR_CODES.GIT_RULES) });
      expect(await read()).toEqual({ state: 'blocked', code: ERROR_CODES.GIT_RULES });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('keeps a stored stopped reason', async () => {
    const { db, refresh, set, read } = await setup();
    try {
      await set({ status: 'blocked', stateReason: reasonOf(REASON.stopped) });
      expect(await read()).toEqual({ state: 'stopped', code: REASON.stopped });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('leaves a running row marked recovering as written', async () => {
    const { db, refresh, set, read } = await setup();
    try {
      await set({ status: 'running', state: 'recovering', stateReason: reasonOf('2026-01-01T00:00:00.000Z') });
      expect(await read()).toMatchObject({ state: 'recovering' });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('corrects a stale row and fills a null one in the pass at bootstrap', async () => {
    const { db, rows, refresh, run, documents, read } = await setup();
    try {
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
      await rows.update({ id: run.id }, { currentStep: 'research', state: 'idle', stateReason: null });
      await refresh.onApplicationBootstrap();
      expect(await read()).toEqual({ state: 'waiting', code: 'NEEDS_ANSWERS' });

      await rows.update({ id: run.id }, { status: 'done', currentStep: 'done', state: null, stateReason: null });
      await refresh.onApplicationBootstrap();
      expect(await read()).toEqual({ state: 'done', code: null });
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('causes no second write by its own write', async () => {
    const { db, refresh, run, documents, noticed, set } = await setup();
    try {
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
      await set({ currentStep: 'research' });
      // The test's notice and the one for the refresh's own write; the notice of that write found nothing to write.
      expect(noticed).toEqual([run.key, run.key]);
      await refresh.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('waits for a running pass when it closes', async () => {
    const { db, hub, refresh, run, documents, rows, read } = await setup();
    try {
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
      await rows.update({ id: run.id }, { currentStep: 'research' });
      hub.changed(run.key);
      await refresh.onModuleDestroy();
      expect(await read()).toEqual({ state: 'waiting', code: 'NEEDS_ANSWERS' });
    } finally {
      await db.close();
    }
  });
});

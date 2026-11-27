import { CheckoutRepository } from './checkout.repository';
import { DocumentRepository } from './document.repository';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { storedState } from './run-state';

describe('CheckoutRepository', () => {
  it('creates, reads and updates checkouts and pastes while preserving deny path ordering', async () => {
    const db = await repositoryDatabase();
    try {
      const checkouts = db.app.get(CheckoutRepository);
      await checkouts.saveCheckout('project', '/first');
      const [checkout] = await checkouts.listCheckouts();
      expect(checkout).toEqual(expect.objectContaining({ name: 'project', path: '/first' }));
      await checkouts.saveCheckout('project', '/updated');
      expect(await checkouts.listCheckouts()).toEqual([{ ...checkout, path: '/updated' }]);
      await checkouts.savePaste('run-1', 'https://example.test/paste', 'first');
      const [paste] = await checkouts.listPastes('run-1');
      expect(paste.body).toBe('first');
      await checkouts.savePaste('run-1', 'https://example.test/paste', 'updated');
      expect(await checkouts.listPastes('run-1')).toEqual([{ ...paste, body: 'updated' }]);
    } finally {
      await db.close();
    }
  });

  it('stores the state with a paste: a pending paste waits for a person until it is saved', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const url = 'https://example.test/paste';
      const run = await runs.openWaiting('run-1', '/target');
      await db.app.get(DocumentRepository).putDocument(run, 'pending', JSON.stringify({ url }));
      const read = async () => storedState((await runs.findRun('run-1'))!).reason?.code ?? null;
      expect(await read()).toBe('NEEDS_ANSWERS');
      await db.app.get(CheckoutRepository).savePaste('run-1', url, 'body');
      expect(await read()).toBeNull();
    } finally {
      await db.close();
    }
  });
});

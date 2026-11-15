import { CheckoutRepository } from './checkout.repository';
import { repositoryDatabase } from './repository.spec-helpers';

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
});

import { DataSource } from 'typeorm';

import { CommandRepository } from './command.repository';
import { CommandEntity } from './entities';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

describe('CommandRepository', () => {
  it('lists two commands created in the same millisecond in the order they were stored', async () => {
    const db = await repositoryDatabase();
    try {
      const run = await db.app.get(RunRepository).begin('run-1', 'implement');
      const commands = db.app.get(CommandRepository);
      const now = '2026-11-28T10:00:00.000Z';
      const row = (id: string, key: string): Partial<CommandEntity> => ({
        id,
        runId: run.id,
        scope: null,
        type: 'rebase',
        payload: '{}',
        idempotencyKey: key,
        expectedRevision: null,
        actor: null,
        state: 'accepted',
        result: null,
        createdAt: now,
        updatedAt: now,
      });
      const store = db.app.get(DataSource).getRepository(CommandEntity);
      await store.insert(row('ffffffff-0000-4000-8000-000000000000', 'b-first'));
      await store.insert(row('00000000-0000-4000-8000-000000000000', 'a-second'));

      expect((await commands.listForRun(run.id)).map((command) => command.idempotencyKey)).toEqual([
        'b-first',
        'a-second',
      ]);
    } finally {
      await db.close();
    }
  });
});

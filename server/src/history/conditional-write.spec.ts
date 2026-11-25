import type { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { conditionalUpdate } from './conditional-write';
import { RunEntity } from './entities';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

describe('conditionalUpdate', () => {
  async function open() {
    const db = await repositoryDatabase();
    const runs = db.app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
    const row = await db.app.get(RunRepository).openWaiting('run-1', '/target');
    return { db, runs, row };
  }

  it('writes the changed and the extra columns while the values read still hold', async () => {
    const { db, runs, row } = await open();
    try {
      const written = await conditionalUpdate(runs, row.id, { prompt: 'new' }, () => null, { title: 'T' });
      expect(written).toBe(true);
      expect(await runs.findOneBy({ id: row.id })).toEqual(expect.objectContaining({ prompt: 'new', title: 'T' }));
    } finally {
      await db.close();
    }
  });

  it('writes nothing when a changed column no longer holds the value read', async () => {
    const { db, runs, row } = await open();
    try {
      const written = await conditionalUpdate(runs, row.id, { prompt: 'new' }, () => 'something else', { title: 'T' });
      expect(written).toBe(false);
      expect(await runs.findOneBy({ id: row.id })).toEqual(expect.objectContaining({ prompt: null, title: null }));
    } finally {
      await db.close();
    }
  });

  it('matches a boolean and a JSON column in the form the database stores them', async () => {
    const { db, runs, row } = await open();
    try {
      const read = (column: string) => ({ split: false, baseTips: null })[column];
      expect(await conditionalUpdate(runs, row.id, { split: true }, read)).toBe(true);
      expect(await conditionalUpdate(runs, row.id, { split: false }, read)).toBe(false);
      await runs.update({ id: row.id }, { baseTips: { web: 'a' } });
      const readTips = () => ({ web: 'a' });
      expect(await conditionalUpdate(runs, row.id, { baseTips: { web: 'b' } }, readTips)).toBe(true);
      expect((await runs.findOneBy({ id: row.id }))!.baseTips).toEqual({ web: 'b' });
    } finally {
      await db.close();
    }
  });
});
